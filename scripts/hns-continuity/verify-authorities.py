import json, hashlib, socket, ssl, time, sys, struct
import dns.rrset
from datetime import timezone
from pathlib import Path
import dns.message, dns.dnssec, dns.name, dns.rdatatype
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
def read_document(path):
    with path.open("rb") as stream:
        wire = stream.read(8 * 1024 * 1024 + 1)
    if not wire or len(wire) > 8 * 1024 * 1024:
        raise ValueError("Observation file size invalid")
    return json.loads(wire)


base = Path(sys.argv[1])
replay = len(sys.argv) > 2 and sys.argv[2] == '--replay'
config = read_document(base / 'transport.json')
retained = read_document(base / 'authority-verification.json') if replay else None
verification_time = retained['observed_at'] if replay else time.time()
state = read_document(base / 'state.json')
chain = read_document(base / 'chain.json')
root = state['dns']['canonical_root']
resources = {r['ref']: r['result'] for r in chain['rows']}
views = []
for transport in config['authorities']:
    address = transport['address']
    exchanges = []

    def query(name, kind):
        if replay:
            view = next((v for v in retained['views'] if v['address'] == address))
            exchange = next((e for e in view['exchanges'] if e['name'] == name and e['type'] == kind))
            request_wire = bytes.fromhex(exchange['request_hex'])
            response_wire = bytes.fromhex(exchange['response_hex'])
            request = dns.message.from_wire(request_wire)
            if len(request.question) != 1 or request.question[0].name != dns.name.from_text(name) or request.question[0].rdtype != dns.rdatatype.from_text(kind):
                raise ValueError('Question mismatch')
        else:
            request = dns.message.make_query(name, kind, want_dnssec=True)
            request_wire = request.to_wire()
            with socket.create_connection(('127.0.0.1', transport['dns_port']), timeout=8) as stream:
                stream.sendall(struct.pack('!H', len(request_wire)) + request_wire)

                def read_exact(count):
                    data = b''
                    while len(data) < count:
                        chunk = stream.recv(count - len(data))
                        if not chunk:
                            raise ValueError('Truncated DNS response')
                        data += chunk
                    return data
                size = struct.unpack('!H', read_exact(2))[0]
                response_wire = read_exact(size)
        response = dns.message.from_wire(response_wire)
        if response.rcode() != 0 or not request.is_response(response):
            raise ValueError('DNS response refused')
        exchanges.append({'name': name, 'type': kind, 'request_hex': request_wire.hex(), 'response_hex': response_wire.hex()})
        rr = next((r for r in response.answer if r.rdtype == dns.rdatatype.from_text(kind)))
        sig = next((r for r in response.answer if r.rdtype == dns.rdatatype.RRSIG and r.covers == rr.rdtype))
        return (rr, sig)
    keys = {}
    derived = {}
    for zone in ['pirate', root]:
        rr, sig = query(zone, 'DNSKEY')
        name = dns.name.from_text(zone)
        if rr.name != name:
            raise ValueError('DNSKEY answer owner mismatch')
        ds = [r for r in resources['getnameresource:' + zone]['records'] if r['type'] == 'DS']
        matching = []
        for key in rr:
            candidates = [dns.dnssec.make_ds(name, key, alg).to_text().lower() for alg in ['SHA256', 'SHA384']]
            expected = [f'{r['keyTag']} {r['algorithm']} {r['digestType']} {r['digest'].lower()}' for r in ds]
            if sorted(candidates) == sorted(expected):
                matching.append(key)
        if len(matching) != 1:
            raise ValueError('Chain DS does not authenticate the DNSKEY')
        trusted = dns.rrset.from_rdata(name, rr.ttl, matching[0])
        dns.dnssec.validate(rr, sig, {name: trusted}, now=verification_time)
        keys[zone] = rr
        derived[zone] = [dns.dnssec.make_ds(name, matching[0], alg).to_text().lower() for alg in ['SHA256', 'SHA384']]
    for authority in config['authorities']:
        ns, expected_ip = (authority['nameserver'], authority['address'])
        rr, sig = query(ns, 'A')
        dns.dnssec.validate(rr, sig, {dns.name.from_text('pirate'): keys['pirate']}, now=verification_time)
        if rr.name != dns.name.from_text(ns):
            raise ValueError('Parent answer owner mismatch')
        if [r.address for r in rr] != [expected_ip]:
            raise ValueError('Parent glue disagreement')
    txt, txtsig = query('_pirate.' + root, 'TXT')
    dns.dnssec.validate(txt, txtsig, {dns.name.from_text(root): keys[root]}, now=verification_time)
    if txt.name != dns.name.from_text('_pirate.' + root):
        raise ValueError('TXT answer owner mismatch')
    txt_values = [b''.join(r.strings).decode() for r in txt]
    if len(txt_values) != 1:
        raise ValueError('Ownership TXT is ambiguous')
    rr, sig = query('_443._tcp.app.' + root, 'TLSA')
    dns.dnssec.validate(rr, sig, {dns.name.from_text(root): keys[root]}, now=verification_time)
    if rr.name != dns.name.from_text('_443._tcp.app.' + root):
        raise ValueError('TLSA answer owner mismatch')
    expected = state['dns']['gateway_certificate_spki_sha256']
    if not any((r.usage == 3 and r.selector == 1 and (r.mtype == 1) and (r.cert.hex() == expected) for r in rr)):
        raise ValueError('TLSA mismatch')
    views.append({'address': address, 'derived_ds': derived, 'ownership_txt': txt_values[0], 'exchanges': exchanges})
if replay:
    certificate_der = bytes.fromhex(retained['certificate_der_hex'])
    status = retained['app_status']
else:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection(('127.0.0.1', config['gateway_port']), timeout=8) as tcp:
        with ctx.wrap_socket(tcp, server_hostname='app.' + root) as tls:
            certificate_der = tls.getpeercert(binary_form=True)
            tls.sendall(('GET / HTTP/1.1\r\nHost: app.' + root + '\r\nConnection: close\r\n\r\n').encode())
            status = tls.recv(1024).split(b'\r\n')[0].decode()
cert = x509.load_der_x509_certificate(certificate_der)
digest = hashlib.sha256(cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).hexdigest()
if digest != expected:
    raise ValueError('Served certificate SPKI mismatch')
if cert.not_valid_before.replace(tzinfo=timezone.utc).timestamp() > verification_time:
    raise ValueError('Certificate is not yet valid')
if cert.not_valid_after.replace(tzinfo=timezone.utc).timestamp() <= verification_time + 7 * 86400:
    raise ValueError('Certificate expiry too near')
if not status.startswith(('HTTP/1.1 200 ', 'HTTP/1.0 200 ')):
    raise ValueError('App does not serve successfully')
result = {'certificate_der_hex': certificate_der.hex(), 'observed_at': verification_time, 'views': views, 'certificate_spki': digest, 'certificate_expires': cert.not_valid_after.replace(tzinfo=timezone.utc).isoformat(), 'app_status': status}
if not replay:
    (base / 'authority-verification.json').write_text(json.dumps(result))
else:
    for key in ['views', 'certificate_spki', 'certificate_expires', 'app_status']:
        if result[key] != retained[key]:
            raise ValueError('Retained verification facts changed')
print(json.dumps({'authorities': len(views), 'dnssec_validated': True, 'tlsa_spki_match': True, 'app_status': status}))
