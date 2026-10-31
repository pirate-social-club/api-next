#!/usr/bin/env python3
"""One separately reviewed local PG18 fixture; default is an unbound plan."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import time

REPO = Path('/media/t42/codedrive/Code/pirate-workspace/.worktrees/api-next/api-website-production-release-tools-20261031')
APP = REPO.parent / 'v1-hns-browser-renewal-cookies-api-20261029'
APP_SHA = 'a6bb14b7669ec5900d20b20d1fb077a5bead38bc'
APP_TREE = 'ba935ba8fdc0526f1a6c0b251a75027314034900'
PRODUCTION = REPO.parents[2] / '.archive/v1-shared-launch-execution-20261023/checkpoints-20261030/final-production-qualification-a6-333/website-production-operation-20261031'
IMAGE = 'sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
DRIVER = REPO / 'scripts/production-compatibility/qualification/qualify-compatibility-pg18.ts'
TOOLS = {'python': '/usr/bin/python3', 'docker': '/usr/bin/docker', 'git': '/usr/bin/git',
         'timeout': '/usr/bin/timeout', 'bun': '/home/t42/.bun/bin/bun',
         'node': '/home/t42/.nvm/versions/node/v24.14.0/bin/node', 'systemctl': '/usr/bin/systemctl'}
MEMORY, PIDS, TASK = 1610612736, 128, 'pirate-v1-compatibility-qualification'
MANIFESTS = {'release': 'scripts/production-release/source-manifest.json',
             'reader': 'scripts/production-compatibility/source-manifest.json',
             'qualification': 'scripts/production-compatibility/qualification/source-manifest.json'}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def utc():
    return dt.datetime.now(dt.timezone.utc)


def instant(value):
    require(isinstance(value, str) and value.endswith('Z'), 'UTC timestamp required')
    return dt.datetime.fromisoformat(value[:-1] + '+00:00')


def run(argv, env, timeout=10, check=True):
    result = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    require(not check or result.returncode == 0, 'Bounded subprocess refused')
    return result


def write(path, value):
    with path.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def process_identity(pid):
    text = Path(f'/proc/{pid}/stat').read_text()
    fields = text[text.rfind(')') + 2:].split()
    return {'pid': pid, 'start_ticks': fields[19], 'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def same_process(identity):
    try:
        return process_identity(identity['pid']) == identity
    except (FileNotFoundError, ProcessLookupError):
        return False


def known_processes(docker, cid, strict=True):
    identities = []
    observed = docker('top', cid, '-eo', 'pid', check=False)
    require(not strict or observed.returncode == 0, 'Owned process census refused')
    rows = observed.stdout.decode().splitlines()[1:] if observed.returncode == 0 else []
    for value in rows:
        try:
            identities.append(process_identity(int(value)))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return identities


def source(request, env):
    require(Path(__file__).resolve().parents[2] == REPO, 'Controller must be committed at its fixed path')
    def git(root, *args):
        return run([TOOLS['git'], '-C', str(root), *args], env, 15).stdout.decode().strip()
    observed = {'tooling_source': git(REPO, 'rev-parse', 'HEAD'), 'tooling_tree': git(REPO, 'rev-parse', 'HEAD^{tree}'), 'manifests': {}, 'binaries': {}}
    require(observed['tooling_source'] == request['tooling_source'], 'Tooling HEAD differs')
    require(observed['tooling_tree'] == request['tooling_tree'], 'Tooling tree differs')
    require(git(REPO, 'status', '--porcelain=v1', '--untracked-files=all') == '', 'Tooling is dirty')
    require(git(APP, 'rev-parse', 'HEAD') == APP_SHA and git(APP, 'rev-parse', 'HEAD^{tree}') == APP_TREE, 'Application differs')
    require(git(APP, 'status', '--porcelain=v1', '--untracked-files=all') == '', 'Application is dirty')
    changed = git(REPO, 'diff', '--name-only', '--no-renames', APP_SHA, 'HEAD', '--').splitlines()
    require(all(p.startswith(('scripts/production-release/', 'scripts/production-compatibility/')) or p == 'tsconfig.scripts.json' for p in changed), 'Maintained input changed')
    for key, relative in MANIFESTS.items():
        path = REPO / relative
        observed['manifests'][key] = digest(path)
        require(observed['manifests'][key] == request['manifests'][key], 'Source manifest differs')
        for name, expected in json.loads(path.read_text())['files'].items():
            require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'Foreign manifest path')
            require(digest(path.parent / name) == expected, 'Manifest member differs')
    observed.update({'controller_sha256': digest(__file__), 'driver_sha256': digest(DRIVER)})
    require(observed['controller_sha256'] == request['controller_sha256'] and observed['driver_sha256'] == request['driver_sha256'], 'Executor source differs')
    require(set(request['binaries']) == set(TOOLS), 'Binary inventory differs')
    for key, path in TOOLS.items():
        observed['binaries'][key] = digest(path)
        require(observed['binaries'][key] == request['binaries'][key], 'Binary differs: ' + key)
    require(not PRODUCTION.exists(), 'Actual production operation namespace must remain absent')
    observed.update({'application_source_verified': APP_SHA, 'application_tree_verified': APP_TREE})
    return observed


def unit_limits(request, env):
    unit = request['unit_name']
    require(unit == 'pirate-v1-compatibility-' + request['run_root'][-32:] + '.service', 'Unexpected parent unit')
    group = next(line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    require(group.endswith('/' + unit), 'Controller is not in the reviewed user unit')
    root = Path('/sys/fs/cgroup') / group.lstrip('/')
    values = {key: (root / key).read_text().strip() for key in ['memory.max', 'memory.swap.max', 'cpu.max', 'pids.max']}
    quota, period = map(int, values['cpu.max'].split())
    require(values['memory.max'] == '536870912' and values['memory.swap.max'] == '0', 'Parent memory limits differ')
    require(quota * 4 == period and values['pids.max'] == '128', 'Parent CPU/PID limits differ')
    mask = next(line.split(':', 1)[1].strip() for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('Cpus_allowed_list:'))
    require(mask == '1', 'Parent process affinity must be CPU1')
    properties = run([TOOLS['systemctl'], '--user', 'show', unit, '-p', 'RuntimeMaxUSec', '-p', 'TimeoutStopUSec', '-p', 'ControlGroup'], env).stdout.decode()
    values.update(dict(line.split('=', 1) for line in properties.splitlines()))
    require(values['ControlGroup'] == group and values['RuntimeMaxUSec'] in ['6min', '360s'] and values['TimeoutStopUSec'] == '20s', 'Parent deadlines differ')
    return {**values, 'process_affinity': mask, 'unit': unit}


def inspect(docker, cid):
    value = json.loads(docker('inspect', cid).stdout)[0]
    return value


def find_owned_name(docker, name):
    ids = docker('container', 'ls', '-aq', '--no-trunc', '--filter', 'name=^/' + name + '$').stdout.decode().split()
    require(len(ids) <= 1 and all(re.fullmatch('[a-f0-9]{64}', value) for value in ids), 'Named container lookup is ambiguous')
    return ids[0] if ids else None


def container_identity(value, cid, name, request_sha, review_sha):
    config = value['Config']
    require(value['Id'] == cid and value['Name'] == '/' + name and value['Image'] == IMAGE, 'Foreign container identity')
    labels = {key: (config['Labels'] or {}).get(key) for key in ['pirate.task', 'pirate.request', 'pirate.review']}
    require(labels == {'pirate.task': TASK, 'pirate.request': request_sha, 'pirate.review': review_sha}, 'Foreign container labels')
    return labels


def filtered_container(value, labels, name):
    host = value['HostConfig']
    return {'id': value['Id'], 'name': name, 'image': value['Image'], 'labels': labels,
            'network': host['NetworkMode'], 'memory': host['Memory'], 'memory_swap_total': host['MemorySwap'],
            'nano_cpus': host['NanoCpus'], 'cpuset': host['CpusetCpus'], 'pids': host['PidsLimit'], 'shm': host['ShmSize'],
            'tmpfs': host['Tmpfs'], 'running': value['State']['Running'], 'oom_killed': value['State']['OOMKilled'],
            'exit_code': value['State']['ExitCode'], 'pid': value['State']['Pid']}


def owned(value, cid, name, request_sha, review_sha, socket):
    labels = container_identity(value, cid, name, request_sha, review_sha)
    config, host = value['Config'], value['HostConfig']
    require(host['NetworkMode'] == 'none' and not host['PortBindings'], 'Container networking differs')
    require(host['Memory'] == MEMORY and host['MemorySwap'] == MEMORY and host['NanoCpus'] == 1000000000, 'Container memory/CPU differs')
    require(host['CpusetCpus'] == '2' and host['PidsLimit'] == PIDS and host['ShmSize'] == 67108864, 'Container affinity/PID/shared memory differs')
    require(host['RestartPolicy']['Name'] == 'no', 'Restart policy differs')
    require(config['Entrypoint'] == ['/usr/bin/timeout'], 'Hard deadline entrypoint differs')
    expected = ['--signal=TERM', '--kill-after=10s', '300s', '/usr/local/bin/docker-entrypoint.sh', 'postgres', '-c', "listen_addresses=", '-c', 'max_locks_per_transaction=64', '-c', 'shared_buffers=64MB', '-c', 'unix_socket_directories=/var/run/postgresql', '-c', 'cluster_name=pirate_compatibility_' + socket.parent.name[-32:]]
    require(config['Cmd'] == expected, 'Container command/deadline differs')
    require('PGDATA=/var/lib/postgresql/18/docker' in config['Env'], 'Cached PGDATA differs')
    require(host['Tmpfs'] == {'/var/lib/postgresql': 'rw,size=512m', '/tmp': 'rw,size=64m'}, 'Container tmpfs differs')
    binds = [mount for mount in value['Mounts'] if mount['Type'] == 'bind']
    require(len(binds) == 1 and binds[0]['Source'] == str(socket) and binds[0]['Destination'] == '/var/run/postgresql' and binds[0]['RW'], 'Container bind mounts differ')
    require(all(mount['Type'] == 'bind' or (mount['Type'] == 'tmpfs' and mount['Destination'] in ['/var/lib/postgresql', '/tmp']) for mount in value['Mounts']), 'Unexpected container mount')
    return filtered_container(value, labels, name)


def cancel(number, _frame):
    raise SystemExit(128 + number)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path); parser.add_argument('--review', type=Path)
    parser.add_argument('--execute', action='store_true'); args = parser.parse_args()
    if not args.execute:
        print(json.dumps({'plan_only': True, 'image': IMAGE, 'network': 'none', 'driver_seconds': 240,
                          'container_seconds': 300, 'outer_seconds': 360, 'managed_credentials': False})); return
    require(args.request and args.review and sys.flags.isolated, 'Execute requires request, review and python -I')
    forbidden = ('PG', 'CLOUDFLARE_', 'CF_', 'INFISICAL_', 'AWS_', 'AZURE_', 'GOOGLE_', 'DOCKER_', 'PYTHONPATH', 'PYTHONHOME', 'GIT_', 'GH_', 'GITHUB_', 'SSH_', 'OPENAI_')
    require(not any(key.startswith(forbidden) or key.endswith(('_TOKEN', '_SECRET', '_PASSWORD', '_API_KEY')) or key in ['DATABASE_URL', 'RUNTIME_POSTGRES_URL', 'CONTROL_PLANE_POSTGRES_ADMIN_URL', 'CONTROL_PLANE_POSTGRES_RUNTIME_URL'] for key in os.environ), 'Foreign authentication/database environment')
    env = {'PATH': str(Path(TOOLS['node']).parent) + ':/home/t42/.bun/bin:/usr/bin:/bin', 'HOME': os.environ['HOME'],
           'LANG': 'C.UTF-8', 'TZ': 'UTC', 'GIT_OPTIONAL_LOCKS': '0', 'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()), 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(os.getuid()) + '/bus'}
    require(args.request.is_absolute() and args.review.is_absolute(), 'Review references must be absolute')
    require(args.request.resolve() == args.request and args.review.resolve() == args.review, 'Review reference path changed')
    request_bytes, review_bytes = args.request.read_bytes(), args.review.read_bytes()
    request, review = json.loads(request_bytes), json.loads(review_bytes)
    request_sha, review_sha = hashlib.sha256(request_bytes).hexdigest(), hashlib.sha256(review_bytes).hexdigest()
    def references_unchanged():
        require(digest(args.request) == request_sha and digest(args.review) == review_sha, 'Parent review references changed')
    require(request['kind'] == 'local-pg18-compatibility-controller-request-v1', 'Request kind differs')
    require(review['kind'] == 'independent-local-pg18-compatibility-operation-review-v1' and review['request_sha256'] == request_sha, 'Review binding differs')
    require(review['accepted'] is True and review['reviewer_role'] == 'independent_reviewer' and review['findings'] == [], 'Independent operation review required')
    require(review['authorizes_derived_local_admission'] is True, 'Review must authorize the observed-identity admission derivation')
    start, expires = instant(request['starts_at']), instant(request['expires_at'])
    require(start <= utc() < expires and (expires - start).total_seconds() <= 360 and (expires - utc()).total_seconds() >= 330, 'Operation UTC window differs')
    require(instant(review['reviewed_at']) <= utc() and review['controller_sha256'] == request['controller_sha256'], 'Review time/source differs')
    run_root = Path(request['run_root'])
    require(re.fullmatch(r'/tmp/pirate-v1-compatibility-[a-f0-9]{32}', str(run_root)) and not run_root.exists(), 'Run directory is not fresh')
    require(Path('/tmp').resolve() == Path('/tmp'), 'Unexpected temporary root')
    references_unchanged(); source_before = source(request, env); parent = unit_limits(request, env)
    require(digest('/proc/self/exe') == request['binaries']['python'], 'Running Python binary differs')
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, cancel)
    os.umask(0o077); run_root.mkdir(mode=0o700)
    socket = run_root / 'socket'; socket.mkdir(mode=0o700); socket.chmod(0o3775)
    config = run_root / 'docker-config'; config.mkdir(mode=0o700)
    def docker(*parts, check=True, timeout=10, extra=None):
        return run([TOOLS['docker'], '--host', 'unix:///var/run/docker.sock', '--config', str(config), *parts], {**env, **(extra or {})}, timeout, check)
    cid, attempted, driver, driver_output, known = None, False, None, None, []
    password = secrets.token_hex(32); name = 'pirate-compat-' + request_sha[:16]
    result = {'kind': 'local-pg18-compatibility-controller-result-v1', 'request_sha256': request_sha, 'review_sha256': review_sha,
              'started_at': utc().isoformat(), 'success': False, 'parent': parent, 'source_before': source_before, 'production_accessed': False}
    try:
        require(not docker('ps', '-q').stdout.strip(), 'Another container is running')
        require(docker('image', 'inspect', IMAGE, '--format', '{{.Id}}').stdout.decode().strip() == IMAGE, 'Cached image missing/different')
        require(find_owned_name(docker, name) is None, 'Container name already exists')
        command = ['create', '--pull=never', '--name', name, '--label', 'pirate.task=' + TASK, '--label', 'pirate.request=' + request_sha,
                   '--label', 'pirate.review=' + review_sha, '--network', 'none', '--restart=no', '--cpus=1', '--cpuset-cpus=2',
                   '--memory=1536m', '--memory-swap=1536m', '--pids-limit=128', '--shm-size=64m', '--stop-timeout=10',
                   '--tmpfs', '/var/lib/postgresql:rw,size=512m', '--tmpfs', '/tmp:rw,size=64m',
                   '--mount', 'type=bind,source=' + str(socket) + ',target=/var/run/postgresql', '--env', 'POSTGRES_PASSWORD',
                   '--env', 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=reject', '--entrypoint', '/usr/bin/timeout', IMAGE,
                   '--signal=TERM', '--kill-after=10s', '300s', '/usr/local/bin/docker-entrypoint.sh', 'postgres', '-c', 'listen_addresses=',
                   '-c', 'max_locks_per_transaction=64', '-c', 'shared_buffers=64MB', '-c', 'unix_socket_directories=/var/run/postgresql',
                   '-c', 'cluster_name=pirate_compatibility_' + run_root.name[-32:]]
        attempted = True; acknowledgement = docker(*command, timeout=30, extra={'POSTGRES_PASSWORD': password}).stdout.decode().strip()
        require(re.fullmatch('[a-f0-9]{64}', acknowledgement), 'Create acknowledgement is malformed'); cid = acknowledgement
        result['container'] = owned(inspect(docker, cid), cid, name, request_sha, review_sha, socket)
        write(run_root / 'owned-container.json', result['container']); docker('start', cid)
        ready_until = time.monotonic() + 50
        while time.monotonic() < ready_until:
            logs = docker('logs', cid, check=False)
            text = (logs.stdout + logs.stderr).decode(errors='replace')
            socket_path = socket / '.s.PGSQL.5432'
            try:
                socket_exists = stat.S_ISSOCK(socket_path.stat().st_mode)
            except FileNotFoundError:
                socket_exists = False
            if 'PostgreSQL init process complete' in text and socket_exists:
                if docker('exec', cid, 'pg_isready', '-U', 'postgres', '-d', 'postgres', '-h', '/var/run/postgresql', check=False).returncode == 0:
                    break
            time.sleep(0.5)
        else:
            raise RuntimeError('Owned fixture readiness expired')
        actual = owned(inspect(docker, cid), cid, name, request_sha, review_sha, socket)
        require(actual['running'], 'Owned fixture is not running')
        caps = docker('exec', cid, 'cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max', '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/cpuset.cpus.effective').stdout.decode().splitlines()
        require(len(caps) == 5 and caps[0:2] == [str(MEMORY), '0'] and caps[3:] == ['128', '2'], 'Actual container caps differ')
        quota, period = map(int, caps[2].split()); require(quota == period, 'Actual container CPU quota differs')
        require(stat.S_IMODE(run_root.stat().st_mode) == 0o700 and stat.S_IMODE(socket.stat().st_mode) == 0o3775, 'Owned directory access modes differ')
        known = known_processes(docker, cid)
        require(any(value['pid'] == actual['pid'] for value in known), 'Owned init PID was not observed')
        write(run_root / 'effective-container.json', {**actual, 'cgroup_values': caps, 'known_processes': known})
        require((expires - utc()).total_seconds() >= 240, 'Insufficient derived admission time')
        admission = {'kind': 'local-pg18-compatibility-qualification-v1', 'accepted': review['accepted'], 'reviewer_role': review['reviewer_role'],
                     'findings': review['findings'], 'derived_from_parent_operation_review': True, 'parent_request_sha256': request_sha,
                     'parent_review_sha256': review_sha, 'runtime_observation_is_not_an_independent_attestation': True,
                     'run_root': str(run_root), 'api_source': APP_SHA, 'tooling_source': request['tooling_source'],
                     'reader_manifest_sha256': request['manifests']['reader'], 'qualification_manifest_sha256': request['manifests']['qualification'],
                     'driver_sha256': request['driver_sha256'], 'image_id': IMAGE, 'container_id': cid, 'network_mode': 'none', 'public_ports': 0,
                     'driver_timeout_seconds': 240, 'outer_timeout_seconds': 360, 'starts_at': request['starts_at'], 'expires_at': request['expires_at']}
        references_unchanged(); write(run_root / 'admission.json', admission); source(request, env)
        require((expires - utc()).total_seconds() >= 255, 'Insufficient driver-start admission margin')
        argv = [TOOLS['timeout'], '--signal=TERM', '--kill-after=10s', '240s', TOOLS['bun'], str(DRIVER), str(run_root)]
        driver = subprocess.Popen(argv, env={**env, 'PIRATE_COMPATIBILITY_FIXTURE_PASSWORD': password}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            driver_output = driver.communicate(timeout=250)
        except subprocess.TimeoutExpired:
            driver.send_signal(signal.SIGTERM); driver_output = driver.communicate(timeout=10)
            raise RuntimeError('Owned driver deadline failed')
        out, error = driver_output
        write(run_root / 'driver-log.json', {'stdout': out.decode(errors='replace').replace(password, '[synthetic-redacted]'), 'stderr': error.decode(errors='replace').replace(password, '[synthetic-redacted]'), 'exit_code': driver.returncode})
        proof = json.loads((run_root / 'qualification-result.json').read_text())
        require(driver.returncode == 0 and proof['success'] is True and proof['case_count'] == 19 and proof['complete_query_count'] == 14 and proof['connections_closed'] is True, 'Genuine driver result did not pass')
        result['driver_exit_code'] = driver.returncode; result['driver_result_sha256'] = digest(run_root / 'qualification-result.json')
        references_unchanged(); source(request, env); result['success'] = True
    except BaseException as error:
        result['failure'] = {'class': type(error).__name__, 'message': str(error).replace(password, '[synthetic-redacted]')}
    finally:
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(number, signal.SIG_IGN)
        cleanup_errors = []
        try:
            if driver and not (run_root / 'driver-log.json').exists():
                if driver.poll() is None:
                    driver.send_signal(signal.SIGTERM)
                if driver_output is None:
                    driver_output = driver.communicate(timeout=10)
                out, error = driver_output
                write(run_root / 'driver-log.json', {'stdout': out.decode(errors='replace').replace(password, '[synthetic-redacted]'), 'stderr': error.decode(errors='replace').replace(password, '[synthetic-redacted]'), 'exit_code': driver.returncode})
        except BaseException as error:
            cleanup_errors.append({'phase': 'owned_driver', 'class': type(error).__name__})
        try:
            if cid is None and attempted:
                cid = find_owned_name(docker, name)
            if cid:
                value = inspect(docker, cid)
                labels = container_identity(value, cid, name, request_sha, review_sha)
                before = filtered_container(value, labels, name)
                if before['running']:
                    known += known_processes(docker, cid, strict=False)
                # Ownership is sufficient for cleanup even when a resource guard refused.
                docker('stop', '--time', '10', cid, timeout=20)
                value = inspect(docker, cid)
                labels = container_identity(value, cid, name, request_sha, review_sha)
                after = filtered_container(value, labels, name)
                require(not after['running'], 'Owned container did not stop')
                logs = docker('logs', cid, check=False)
                write(run_root / 'postgres-log.json', {'stdout': logs.stdout.decode(errors='replace').replace(password, '[synthetic-redacted]'), 'stderr': logs.stderr.decode(errors='replace').replace(password, '[synthetic-redacted]')})
                result['stopped_container'] = after
                if after['oom_killed'] or after['exit_code'] not in [0, 130, 143]:
                    cleanup_errors.append({'phase': 'container_exit', 'message': 'OOM, deadline or abnormal/forced termination'})
                require(docker('rm', cid).stdout.decode().strip() == cid, 'Remove acknowledgement differs')
                require(not docker('container', 'ls', '-aq', '--no-trunc', '--filter', 'id=' + cid).stdout.strip(), 'Owned container still exists')
                require(not any(same_process(identity) for identity in known), 'A known container process remains')
                require(not (socket / '.s.PGSQL.5432').exists() and not (socket / '.s.PGSQL.5432.lock').exists(), 'Owned socket remains')
                result['normal_owned_cleanup_verified'] = True
        except BaseException as error:
            cleanup_errors.append({'phase': 'owned_container', 'class': type(error).__name__, 'message': str(error).replace(password, '[synthetic-redacted]')})
        try:
            references_unchanged(); result['source_after'] = source(request, env); result['parent_after'] = unit_limits(request, env)
            require(utc() <= expires, 'Controller finished outside reviewed UTC window')
        except BaseException as error:
            cleanup_errors.append({'phase': 'source_and_bounds', 'class': type(error).__name__, 'message': str(error).replace(password, '[synthetic-redacted]')})
        if cleanup_errors:
            result['success'] = False; result['cleanup_failures'] = cleanup_errors
        result['finished_at'] = utc().isoformat(); write(run_root / 'controller-result.json', result)
        print(json.dumps({'success': result['success'], 'run_root': str(run_root), 'normal_owned_cleanup_verified': result.get('normal_owned_cleanup_verified', False)}))
    return 0 if result['success'] and result.get('normal_owned_cleanup_verified') else 1


if __name__ == '__main__':
    try:
        outcome = main()
    except BaseException as error:
        print(json.dumps({'success': False, 'initialization_refused': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
    sys.exit(outcome)
