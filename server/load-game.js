/* Load the browser-shared pure game logic into an isolated VM context.
   This keeps one authoritative implementation of aim planning, path physics,
   simultaneous beam resolution and scoring on the server. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadGame() {
  const files = ["js/core.js", "js/ai.js"];
  const source = files
    .map(file => fs.readFileSync(path.join(ROOT, file), "utf8"))
    .join("\n;\n");
  const sandbox = {
    console,
    Math,
    JSON,
    Date,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Infinity,
    NaN
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    source +
      "\n;globalThis.__GS__={" +
      "CFG,compile,allowedFor,genRankedMatch,genMatch,localWorldFor,simulate," +
      "shotPath,resolveRanked,applyElo,chooseBotShot,botReadyDelay,skillOf,repositionSoldiers" +
      "};",
    sandbox,
    { filename: "graphshot-game.js" }
  );
  if (!sandbox.__GS__) throw new Error("failed to load shared game logic");
  return sandbox.__GS__;
}

module.exports = { loadGame, ROOT };
