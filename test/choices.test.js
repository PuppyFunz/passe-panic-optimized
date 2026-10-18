"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const choices = require("../data/choices");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const expectedVerbs = [
  "aller", "apprendre", "arriver", "avoir", "boire", "comprendre", "conduire", "connaître",
  "coudre", "courir", "couvrir", "croire", "cuire", "découvrir", "décrire", "descendre",
  "devenir", "devoir", "disparaître", "dire", "écrire", "entrer", "interdire", "lire", "mettre",
  "monter", "mourir", "naître", "ouvrir", "partir", "permettre", "pouvoir", "prendre", "produire",
  "promettre", "recevoir", "retourner", "revenir", "rire", "savoir", "sortir", "sourire", "suivre",
  "tomber", "venir", "vivre", "voir", "vouloir"
];
for (const verb of expectedVerbs) {
  assert.ok(Array.isArray(choices[verb]), `Missing authored choices for ${verb}`);
  const unique = new Set(choices[verb].map(s => s.normalize("NFC").trim().toLocaleLowerCase("fr")));
  assert.ok(unique.size >= 3, `${verb} needs at least three distinct choices`);
  assert.ok(choices[verb].every(s => typeof s === "string" && s.trim()), `${verb} contains an empty choice`);
}
assert.match(server, /\["coudre",\s*"cousu",\s*"avoir",\s*"to sew",\s*"sewed"\]/, "Coudre should mean to sew");
console.log(`Choice tests passed: ${expectedVerbs.length} verbs, distinct options, and coudre = to sew.`);
