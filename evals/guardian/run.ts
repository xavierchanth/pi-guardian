import { resolve } from "node:path";
import { loadGuardianFallbackCorpus } from "./cases.ts";

const source = resolve("evals/guardian/cases/fallback-policy-cases.yaml");
const corpus = await loadGuardianFallbackCorpus(source);
const allowed = corpus.cases.filter((item) => item.expected.disposition === "allow").length;
const blocked = corpus.cases.length - allowed;

console.log(`Validated ${corpus.cases.length} Guardian fallback cases (${allowed} allow, ${blocked} block).`);
