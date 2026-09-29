#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {digest, equal, validateChallengeOnlyPlan} =
  require('./hns-staging-bob-challenge-plan.cjs');
const bobToolRoot = process.env.BOB_TOOL_ROOT || '/home/t42/Desktop/domains/bob-ledger-transfer';
const fromBobTool = createRequire(path.join(bobToolRoot, 'package.json'));
const hsd = fromBobTool('hsd');
const {Resource} = fromBobTool('hsd/lib/dns/resource');
const {NodeClient, WalletClient} = fromBobTool('hsd/lib/client');

const root = '8s28';
const walletId = 'psc2';
const account = 'default';
const maxFeeDoosh = 1000000;
const dir = process.argv[3];
if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) !== dir
    || !fs.statSync(dir, {throwIfNoEntry:false})?.isDirectory())
  throw new Error('usage: hns-staging-bob-challenge-update.cjs --plan|--execute ABSOLUTE_DIRECTORY');
const publishFile = path.join(dir, 'publish-plan.json');
const sessionFile = path.join(dir, 'session.json');
const unsignedFile = path.join(dir, 'unsigned-plan.json');
const beforeFile = path.join(dir, 'before-broadcast.json');
const broadcastFile = path.join(dir, 'broadcast.json');
function fail(reason) { throw new Error(reason); }

function readBobApiConfig(action) {
  const allowed = new Set(['WALLET_API_KEY', 'NODE_API_KEY', 'API_KEY',
    'BOB_WALLET_HOST', 'BOB_WALLET_PORT', 'BOB_NODE_HOST', 'BOB_NODE_PORT',
    'PSC2_PASSPHRASE']);
  const values = {};
  for (const raw of fs.readFileSync(path.join(bobToolRoot, '.env'), 'utf8').split(/\r?\n/u)) {
    const at = raw.indexOf('=');
    if (at < 1 || raw.trimStart().startsWith('#')) continue;
    const key = raw.slice(0, at).trim();
    if (!allowed.has(key)) continue;
    let value = raw.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  const walletKey = values.WALLET_API_KEY || values.API_KEY;
  const nodeKey = values.NODE_API_KEY || walletKey;
  if (!walletKey || !nodeKey) fail('Bob loopback API credentials are missing');
  if (action === '--execute' && !values.PSC2_PASSPHRASE)
    fail('Bob wallet passphrase is missing from the local private file');
  const walletHost = values.BOB_WALLET_HOST || '127.0.0.1';
  const nodeHost = values.BOB_NODE_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost'].includes(walletHost)
      || !['127.0.0.1', 'localhost'].includes(nodeHost))
    fail('Bob API must be on loopback');
  return {
    wallet: new WalletClient({host: walletHost,
      port: Number(values.BOB_WALLET_PORT || 12039), apiKey: walletKey,
      network: 'main', timeout: 30000}),
    node: new NodeClient({host: nodeHost,
      port: Number(values.BOB_NODE_PORT || 12037), apiKey: nodeKey,
      network: 'main', timeout: 30000}),
    passphrase: values.PSC2_PASSPHRASE,
  };
}

function loadPublishPlan() {
  const bytes = fs.readFileSync(publishFile);
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const plan = JSON.parse(bytes.toString('utf8'));
  const verified = validateChallengeOnlyPlan(session, bytes, plan);
  const desired = {records:verified.replacementRecords};
  const raw = Resource.fromJSON(desired).encode();
  if (!equal(Resource.decode(raw).toJSON().records, verified.replacementRecords)
      || verified.encodedResourceSha256 !== digest(raw))
    fail('staging resource codec or digest does not match the publish plan');
  return {session, plan, verified, desired, desiredRaw:raw, desiredSha256:digest(raw)};
}

function writeReceipt(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // A hard link refuses an existing receipt, including one written by a
  // concurrent process. Rename would silently replace it on Unix.
  try { fs.linkSync(temp, file); }
  finally { fs.unlinkSync(temp); }
  const parent = fs.openSync(dir, 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

async function snapshot(wallet, node, published) {
  const [nodeInfo, walletInfo, walletName, walletResource, pending, safeName, safeResource] =
    await Promise.all([
      node.getInfo(), wallet.getInfo(walletId), wallet.getName(walletId, root),
      wallet.getResource(walletId, root), wallet.getPending(walletId, account),
      node.execute('getnameinfo', [root, true]),
      node.execute('getnameresource', [root, true]),
    ]);
  if (nodeInfo?.network !== 'main' || nodeInfo.chain?.progress !== 1)
    fail('Bob node is not synchronized to mainnet');
  if (!walletInfo || walletInfo.watchOnly !== false || !walletInfo.master?.encrypted)
    fail('psc2 is not the expected encrypted software wallet');
  if (!walletName || walletName.state !== 'CLOSED' || !walletName.registered
      || walletName.expired || walletName.transfer || walletName.revoked)
    fail('8s28 is not an active closed wallet name');
  if (!Array.isArray(pending) || pending.length !== 0)
    fail('psc2 has pending transactions');
  if (!safeName?.info || safeName.info.state !== 'CLOSED'
      || !safeName.info.registered || safeName.info.expired
      || !equal(walletName.owner, safeName.info.owner))
    fail('safe chain owner does not match Bob');
  if (!walletResource?.records || !safeResource?.records
      || !equal(walletResource.records, safeResource.records)
      || !equal(walletResource.records, published.plan.current_records))
    fail('wallet, safe chain and staging baseline differ');
  const baseRaw = Resource.fromJSON(walletResource).encode();
  return {height:nodeInfo.chain.height, owner:walletName.owner,
    baseline:walletResource, baselineSha256:digest(baseRaw)};
}

async function inspect(wallet, json, expectedResource) {
  const mtx = hsd.MTX.fromJSON(json);
  const nameHash = hsd.Rules.hashName(Buffer.from(root, 'ascii'));
  let inputValue = 0;
  let outputValue = 0;
  let updates = 0;
  for (const input of mtx.inputs) {
    const coin = mtx.view.getCoinFor(input);
    if (!coin) fail('transaction input coin metadata is missing');
    inputValue += coin.value;
    if (!await wallet.getKey(walletId, coin.address.toString('main')))
      fail('transaction spends a coin outside psc2');
  }
  for (const output of mtx.outputs) {
    outputValue += output.value;
    if (output.covenant.type === hsd.Rules.types.UPDATE) {
      updates++;
      if (!output.covenant.getHash(0).equals(nameHash)
          || !output.covenant.get(2).equals(expectedResource))
        fail('UPDATE does not contain the exact staging resource');
      if (!await wallet.getKey(walletId, output.address.toString('main')))
        fail('UPDATE owner address is outside psc2');
    } else if (output.covenant.type === hsd.Rules.types.NONE) {
      const key = await wallet.getKey(walletId, output.address.toString('main'));
      if (!key || key.branch !== 1) fail('unexpected non-change output');
    } else fail('unexpected covenant in transaction');
  }
  if (updates !== 1) fail('transaction must have exactly one UPDATE');
  const feeDoosh = inputValue - outputValue;
  if (!Number.isSafeInteger(feeDoosh) || feeDoosh < 0 || feeDoosh > maxFeeDoosh)
    fail('transaction fee exceeds the 1 HNS bound');
  return {mtx, feeDoosh, inputs:mtx.inputs.length, outputs:mtx.outputs.length};
}

async function plan(wallet, node) {
  if ([unsignedFile,beforeFile,broadcastFile].some(fs.existsSync))
    fail('a plan or broadcast receipt already exists');
  const published = loadPublishPlan();
  const state = await snapshot(wallet, node, published);
  const unsigned = await wallet.createUpdate(walletId, {
    name:root, data:published.desired, account, broadcast:false, sign:false,
  });
  const tx = await inspect(wallet, unsigned, published.desiredRaw);
  const receipt = {version:1, createdAt:new Date().toISOString(), network:'main',
    walletId, account, root, sessionId:published.session.sessionId,
    planSha256:published.session.planSha256, publicationDeadline:published.session.publicationDeadline,
    safeHeight:state.height, owner:state.owner, baseline:state.baseline,
    desired:published.desired, baselineSha256:state.baselineSha256,
    desiredSha256:published.desiredSha256, feeDoosh:tx.feeDoosh,
    inputs:tx.inputs, outputs:tx.outputs, unsigned};
  writeReceipt(unsignedFile, receipt);
  console.log(JSON.stringify({result:'planned', root, walletId,
    safeHeight:receipt.safeHeight, baselineSha256:receipt.baselineSha256,
    desiredSha256:receipt.desiredSha256, replacedRecords:1,
    desiredRecords:published.desired.records.length, feeHns:receipt.feeDoosh/1000000}));
}

async function execute(wallet, node, passphrase) {
  if (!fs.existsSync(unsignedFile)) fail('unsigned plan is missing');
  if (fs.existsSync(beforeFile) || fs.existsSync(broadcastFile))
    fail('broadcast already attempted; reconcile its retained txid');
  const saved = JSON.parse(fs.readFileSync(unsignedFile, 'utf8'));
  const published = loadPublishPlan();
  if (saved.root !== root || saved.sessionId !== published.session.sessionId
      || saved.planSha256 !== published.session.planSha256
      || saved.publicationDeadline !== published.session.publicationDeadline)
    fail('plan identity changed');
  const fresh = await snapshot(wallet, node, published);
  if (!equal(fresh.owner,saved.owner)
      || fresh.baselineSha256 !== saved.baselineSha256
      || published.desiredSha256 !== saved.desiredSha256)
    fail('chain or wallet preconditions changed after planning');
  const planned = await inspect(wallet,saved.unsigned,published.desiredRaw);
  if (planned.feeDoosh !== saved.feeDoosh) fail('planned fee changed');
  await wallet.unlock(walletId, passphrase, 120);
  try {
    const signedJson = await wallet.sign(walletId, {tx:planned.mtx.encode().toString('hex')});
    const signed = await inspect(wallet,signedJson,published.desiredRaw);
    if (signed.feeDoosh !== saved.feeDoosh || !signed.mtx.isSigned()
        || !signed.mtx.verify()) fail('signed transaction failed exact verification');
    const txid = signed.mtx.txid();
    writeReceipt(beforeFile, {version:1, attemptedAt:new Date().toISOString(),
      txid, root, walletId, feeDoosh:signed.feeDoosh,
      resourceSha256:published.desiredSha256});
    try {
      const accepted = await node.execute('sendrawtransaction',
        [signed.mtx.encode().toString('hex')]);
      if (accepted !== txid) fail('Bob returned a different transaction id');
      writeReceipt(broadcastFile, {version:1, acceptedAt:new Date().toISOString(),
        txid, root, walletId, feeDoosh:signed.feeDoosh,
        resourceSha256:published.desiredSha256});
      console.log(JSON.stringify({result:'broadcast',root,txid,feeHns:signed.feeDoosh/1000000}));
    } catch { fail('broadcast response ambiguous; reconcile txid before any further action'); }
  } finally { await wallet.lock(walletId).catch(() => undefined); }
}

async function main() {
  const action = process.argv[2];
  if ((action !== '--plan' && action !== '--execute') || process.argv.length !== 4)
    fail('usage: hns-staging-bob-challenge-update.cjs --plan|--execute ABSOLUTE_DIRECTORY');
  const lock = path.join(dir, '.bob-update.lock');
  try { fs.mkdirSync(lock, {mode:0o700}); }
  catch { fail('Bob update ceremony is already active or unresolved'); }
  try {
    const {wallet,node,passphrase} = readBobApiConfig(action);
    if (action === '--plan') await plan(wallet,node);
    else await execute(wallet,node,passphrase);
  } finally { fs.rmdirSync(lock); }
}
main().catch(error => {
  const allowed = /^(Bob|psc2|8s28|safe chain|wallet, safe chain|staging|transaction|UPDATE|planned|chain or wallet|broadcast|unsigned plan|plan identity|a plan|a plan or broadcast|unexpected|signed transaction|hns_bob_challenge_plan_refused)/u;
  console.error('8s28_update_failed: '+(allowed.test(error.message)?error.message:'operation failed'));
  process.exitCode=1;
});
