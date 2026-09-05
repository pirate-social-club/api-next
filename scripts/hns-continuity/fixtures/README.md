# Continuity observation fixture

This compressed, secret-free fixture retains the five observation documents
from the September 5 operator continuity archive. Domain labels and DNS wire
bytes are retained as evidence; they are not runtime defaults. The original
archive remains unchanged. Tests supply the separately observed successor
health generation, which the original snapshot did not include.

The fixture predates certificate DER retention. It can reconstruct candidates
and exercise refusal cases, but it cannot satisfy the maintained command's
certificate replay gate. It is never accepted as fresh production evidence.

Source document SHA-256 values:

state.json: `f67f5161480a7ea8bf09695328df856bf827b42b658ad936438e698f75422449`

chain.json: `1300be4d6c4ef69f73b819d0c6cf91ed6588e56d6c18076fce9e67b272a0f357`

zone-primary.json: `4cc36ef7a3b202887d8ed8dd87f6ee7e40767662fc656dcc4cd53719925b337c`

zone-secondary.json: `619b7f5ebd083b5392c6d51f4cb80b95db0fba98418333711755ec07fb1cae14`

authority-verification.json: `7f954ba9aba9f77e06897e3f5beb19fef8de10658f96d3a239000c1a4923c6f2`

The separately captured `gateway-certificate.der` is the public certificate
read from the gateway on September 5 during command implementation. Its SPKI
matches the archive, and its validity and DNSSEC-bound identity pass replay at
the archived observation time. It is supplementary evidence, not an edit to
the sealed archive. Certificate SHA-256 is
`2696ef3a9c3973a9ddd100b5458d069dc7c40f58868f5058126fb06f9ee0eb2a`.
