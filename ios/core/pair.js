// Pairing primitives of app/src/link-core.js (normalizeCode, pairSecrets, pairProof, pairTopic), reimplemented on
// crypto-shim so they run in a Bare worklet. app/test/crypto-shim.test.cjs checks them against link-core itself.
'use strict';
const b4a = require('b4a');
const crypto = require('./crypto-shim');

// Must equal link-core WORDS (checked by the test).
const WORDS = (
  'acid aged also area army away baby back bake ball band bank barn base bath bead beam bean bear beef bell belt ' +
  'bend best bike bird bite blue boat body bold bone book boot bowl brew bulb bush cake calm camp card care cart ' +
  'case cash cave cell chef chin city clay clip club coal coat code coin cold cook cool copy cord corn cost crab ' +
  'crew crop cube cure dark dart dash data dawn deal deck deep deer desk dial dice dish dock door dove draw drum ' +
  'duck dune dust easy edge epic exit face fact fair farm fast fern film fire fish flag flat flow foam fold folk ' +
  'food fork form fort frog fuel game gate gear gift glow glue goat gold golf good gown grid grin gulf hair half ' +
  'hall hand harp hawk heat herb hero hill hint hive hold hole home hood hook horn host hour huge icon idea inch ' +
  'iron item jade jazz join joke jump keen kelp kept kick kind king kite knee knot lace lady lake lamb lamp land ' +
  'lane lark lava lawn leaf lens life lime line link lion list loaf loft logo loop lord luck lung mail main malt ' +
  'mane mask meal meat menu mild milk mill mint mist mode moon moss moth mule nail navy neck nest news nice node ' +
  'note oath oven pack page palm park path peak pear pine pink pipe plan plum poem pond pony pool port pull pump ' +
  'quiz raft rail rain ramp reed reef rice ring road robe rock roof room rope rose ruby sage sail salt sand seal ' +
  'seed ship silk sink snow soap sock sofa soil song soup star stem swan tail tank team tent tide tile toad tree'
).split(' ').slice(0, 256);
const CODE_WORDS = 5;

const hex = (b) => (typeof b === 'string' ? b : b4a.toString(b, 'hex'));

function normalizeCode(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length !== CODE_WORDS || !words.every((w) => WORDS.includes(w))) return null;
  return words.join('-');
}

/** Pulls a code out of a pasted pairing URI (agentoffice://pair?...&c=<words>) or takes the text as the code. */
function codeFromInput(text) {
  const s = String(text ?? '').trim();
  const m = /[?&]c=([^&#]+)/.exec(s);
  return normalizeCode(m ? decodeURIComponent(m[1]) : s);
}

function pairSecrets(code) {
  const out = crypto.scryptSync(code, 'agent-office/link/pair/v1', 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { topic: out.subarray(0, 32), key: out.subarray(32) };
}

function pairProof(key, role, fromPub, toPub) {
  return crypto.createHmac('sha256', key).update(`${role}\n${hex(fromPub)}\n${hex(toPub)}`).digest('hex');
}

function proofOk(key, role, fromPub, toPub, proof) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return crypto.timingSafeEqual(b4a.from(pairProof(key, role, fromPub, toPub), 'hex'), b4a.from(proof, 'hex'));
}

function pairTopic(secretHex) {
  return crypto.createHash('sha256').update('agent-office/link/topic/v1\n').update(b4a.from(secretHex, 'hex')).digest();
}

module.exports = { WORDS, CODE_WORDS, hex, normalizeCode, codeFromInput, pairSecrets, pairProof, proofOk, pairTopic };
