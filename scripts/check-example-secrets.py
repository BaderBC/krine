#!/usr/bin/env python3
"""Test the actual example entrypoint with Linux-owned 0600 dummy secrets."""
import json
import os
import subprocess
import uuid


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True, **kwargs)


config = json.loads(docker("compose", "--env-file", "deploy/example/local.env.example", "-f", "compose.yaml",
                           "-f", "compose.app.yaml", "-f", "compose.example.yaml",
                           "config", "--format", "json", capture_output=True).stdout)
service = config["services"]["example"]
image = os.environ.get("KRINE_EXAMPLE_IMAGE", service["image"])
fixture = "krine-example-secrets-" + uuid.uuid4().hex
data = fixture + "-data"
secrets = fixture + "-secrets"
probe = r'''
const fs=require('node:fs'), assert=require('node:assert/strict');
assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);
const status=fs.readFileSync('/proc/self/status','utf8');
for(const name of ['CapEff','CapPrm','CapAmb']) assert.match(status,new RegExp(name+':\\s+0000000000000000'));
assert.match(status,/NoNewPrivs:\s+1/);
assert.equal(process.env.KRINE_PUBLIC_KEY,'0'.repeat(64));
assert.equal(process.env.KRINE_SECRET_KEY,'1'.repeat(64));
for(const name of ['browser_public_key','server_secret']) assert.throws(()=>fs.readFileSync('/run/secrets/'+name),{code:'EACCES'});
assert.throws(()=>fs.writeFileSync('/must-not-write','x'),{code:'EROFS'});
const secrets=fs.statSync('/run/secrets');assert.equal(secrets.uid,0);assert.equal(secrets.mode&511,448);
const dir=fs.statSync('/var/lib/draftroom');assert.equal(dir.uid,10001);assert.equal(dir.gid,10001);assert.equal(dir.mode&511,448);
fs.writeFileSync('/var/lib/draftroom/retained','private');
console.log('Example entrypoint preserves private data, reads Linux secrets, and drops every runtime capability.');
'''
created = []
try:
    docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
           "--entrypoint", "/bin/sh", image, "-ec", '[ "$(stat -c \'%u:%g:%a\' /run/secrets)" = 0:0:700 ]')
    for volume in (fixture, data, secrets):
        docker("volume", "create", volume, capture_output=True)
        created.append(volume)
    docker("run", "--rm", "-i", "--network", "none", "--mount", f"type=volume,src={fixture},dst=/fixture",
           "--mount", f"type=volume,src={secrets},dst=/run/secrets",
           "--entrypoint", "/bin/sh", image, "-eu", "-c", "mkdir -p /fixture/dist/server; "
           "printf '%064d' 0 > /run/secrets/browser_public_key; printf '%064d' 0 | tr 0 1 > /run/secrets/server_secret; "
           "chown 1001:1001 /run/secrets/browser_public_key /run/secrets/server_secret; "
           "chmod 0600 /run/secrets/browser_public_key /run/secrets/server_secret; "
           "cp /opt/draftroom/container-entrypoint.mjs /fixture/container-entrypoint.mjs; "
           "cat > /fixture/dist/server/main.js; chmod 0555 /fixture/container-entrypoint.mjs /fixture/dist/server/main.js",
           input=probe)
    assert service["read_only"] and "ALL" in service["cap_drop"]
    assert "no-new-privileges:true" in service["security_opt"]
    caps = [arg for capability in service["cap_add"] for arg in ("--cap-add", capability)]
    for mode in ("0600", "0644"):
        docker("run", "--rm", "--network", "none", "--mount", f"type=volume,src={secrets},dst=/run/secrets",
               "--entrypoint", "/bin/sh", image, "-ec", f"chmod {mode} /run/secrets/*")
        docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", *caps,
               "--security-opt", "no-new-privileges:true", "--env", "DEMO_DATA_DIR=/var/lib/draftroom",
               "--mount", f"type=volume,src={secrets},dst=/run/secrets,readonly",
               "--mount", f"type=volume,src={fixture},dst=/opt/draftroom,readonly",
               "--mount", f"type=volume,src={data},dst=/var/lib/draftroom", image)
finally:
    for volume in created:
        docker("volume", "rm", volume, capture_output=True)
