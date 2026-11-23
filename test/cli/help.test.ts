import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOUN_COMMANDS, VERBS } from "../../src/cli/main.ts";
import { nounNames, verbKey, verbsOf, type Verb } from "../../src/cli/verbs.ts";

/**
 * R4.1, generated from the verb table (W4): EVERY verb answers `--help`/`-h`
 * with its OWN usage, flags and one example (exit 0) — never the whole
 * manual; an unknown FLAG prints the verb's usage and exits 2; `nova help
 * <noun>` lists the noun's verbs. Because every loop below walks
 * `VERBS`/`NOUN_COMMANDS`, a new verb without a help row fails here instead
 * of shipping a surface the operator cannot discover.
 *
 * The last test cross-checks the table against the noun modules' own
 * `switch (sub)` labels: a subcommand added to a module without a table row
 * is unreachable at dispatch AND fails this file.
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const OVERVIEW_HEADER = "USAGE: nova <noun> <sub> [args] [flags]";

type Run = { code: number; stdout: string; stderr: string };

function runNova(args: string[]): Run {
  const res = spawnSync(NOVA, args, { encoding: "utf8", timeout: 30_000, env: { ...process.env } });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function argvOf(verb: Verb): string[] {
  return verb.sub === null ? [verb.noun] : [verb.noun, verb.sub];
}

test("the verb table is the dispatcher's table: every noun has verbs, every verb a noun", () => {
  assert.ok(VERBS.length >= 50, `expected the full surface, got ${VERBS.length} verbs`);
  for (const noun of nounNames()) {
    assert.ok(Object.hasOwn(NOUN_COMMANDS, noun), `verb table names "${noun}" but the dispatcher has no command`);
    assert.ok(verbsOf(noun).length > 0, `"${noun}" has no verbs`);
  }
  for (const noun of Object.keys(NOUN_COMMANDS)) {
    assert.ok(verbsOf(noun).length > 0, `dispatcher serves "${noun}" but the verb table has no row`);
  }
  // one row per verb: no duplicate keys (a duplicate would shadow help)
  const keys = VERBS.map(verbKey);
  assert.deepEqual(keys, [...new Set(keys)]);
});

test("every verb answers --help with ITS OWN usage, flags and one example, exit 0", () => {
  for (const verb of VERBS) {
    const res = runNova([...argvOf(verb), "--help"]);
    assert.equal(res.code, 0, `${verbKey(verb)} --help exited ${res.code}\nstderr: ${res.stderr}`);
    assert.equal(res.stderr, "", `${verbKey(verb)} --help wrote to stderr: ${res.stderr}`);
    assert.ok(
      res.stdout.includes(`  ${verb.synopsis}`),
      `${verbKey(verb)} help lacks its synopsis:\n${res.stdout}`,
    );
    assert.ok(res.stdout.includes(verb.purpose), `${verbKey(verb)} help lacks its purpose`);
    assert.ok(
      res.stdout.includes(`  ${verb.example}`),
      `${verbKey(verb)} help lacks its one example:\n${res.stdout}`,
    );
    for (const flag of verb.flags) {
      const name = flag.split(/\s{2,}/)[0]!.split(" ")[0]!;
      assert.ok(res.stdout.includes(name), `${verbKey(verb)} help omits ${name}`);
    }
    assert.ok(res.stdout.includes("FLAGS"), `${verbKey(verb)} help has no FLAGS block`);
    assert.ok(res.stdout.includes("-h, --help"), `${verbKey(verb)} help does not name --help`);
    // the defect this replaces: a verb's help NEVER prints the whole manual
    assert.ok(
      !res.stdout.includes(OVERVIEW_HEADER),
      `${verbKey(verb)} --help printed the whole-program usage`,
    );
    for (const other of VERBS) {
      if (other === verb) continue;
      assert.ok(
        !res.stdout.includes(other.synopsis),
        `${verbKey(verb)} help leaked ${verbKey(other)}'s synopsis`,
      );
    }
  }
});

test("-h is the same answer as --help, for every verb", () => {
  for (const verb of VERBS) {
    const long = runNova([...argvOf(verb), "--help"]);
    const short = runNova([...argvOf(verb), "-h"]);
    assert.equal(short.code, 0, `${verbKey(verb)} -h exited ${short.code}: ${short.stderr}`);
    assert.equal(short.stdout, long.stdout, `${verbKey(verb)}: -h differs from --help`);
  }
});

test("an unknown FLAG prints THAT verb's usage and exits 2 — never the whole-program dump", () => {
  for (const verb of VERBS) {
    const res = runNova([...argvOf(verb), "--not-a-flag"]);
    assert.equal(res.code, 2, `${verbKey(verb)} --not-a-flag exited ${res.code}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /unknown flag --not-a-flag/, `${verbKey(verb)} did not name the flag`);
    assert.ok(
      res.stderr.includes(`  ${verb.synopsis}`),
      `${verbKey(verb)} printed something other than its own usage:\n${res.stderr}`,
    );
    assert.ok(
      !res.stderr.includes(OVERVIEW_HEADER),
      `${verbKey(verb)} dumped the whole program`,
    );
    assert.equal(res.stdout, "", `${verbKey(verb)} wrote the usage to stdout`);
  }
});

test("nova help <noun> lists every one of that noun's verbs, exit 0", () => {
  for (const noun of nounNames()) {
    const res = runNova(["help", noun]);
    assert.equal(res.code, 0, `nova help ${noun}: ${res.stderr}`);
    assert.equal(res.stderr, "", `nova help ${noun} wrote to stderr`);
    for (const verb of verbsOf(noun)) {
      if (verb.sub !== null) {
        assert.ok(res.stdout.includes(verb.sub), `nova help ${noun} omits "${verb.sub}"`);
      }
      assert.ok(res.stdout.includes(verb.purpose), `nova help ${noun} omits "${verb.sub}"'s purpose`);
    }
    if (verbsOf(noun).length > 1) {
      assert.ok(res.stdout.includes("VERBS"), `nova help ${noun} is not a verb list:\n${res.stdout}`);
    }
  }
});

test("nova <noun> --help answers for every noun (verb list, or the sole verb's usage)", () => {
  for (const noun of nounNames()) {
    const res = runNova([noun, "--help"]);
    assert.equal(res.code, 0, `nova ${noun} --help: ${res.stderr}`);
    for (const verb of verbsOf(noun)) {
      if (verb.sub !== null) assert.ok(res.stdout.includes(verb.sub), `nova ${noun} --help omits ${verb.sub}`);
      else assert.ok(res.stdout.includes(verb.synopsis), `nova ${noun} --help lacks its synopsis`);
    }
  }
});

test("bare `nova help` prints the overview (every verb) on stdout, exit 0; bare `nova` keeps usage semantics", () => {
  const help = runNova(["help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.ok(help.stdout.includes(OVERVIEW_HEADER));
  for (const verb of VERBS) {
    assert.ok(help.stdout.includes(verb.synopsis), `the overview omits ${verbKey(verb)}`);
  }

  // unchanged v1 semantics: the mistake (bare `nova`) is a usage error
  const bare = runNova([]);
  assert.equal(bare.code, 2);
  assert.equal(bare.stdout, "");
  assert.ok(bare.stderr.includes(OVERVIEW_HEADER), bare.stderr);
  assert.match(bare.stderr, /nova <noun> <verb> --help/);
});

test("an unknown noun or subcommand stays a usage error (exit 2) with the program overview", () => {
  const noun = runNova(["bogus"]);
  assert.equal(noun.code, 2);
  assert.match(noun.stderr, /unknown command "bogus"/);
  assert.ok(noun.stderr.includes(OVERVIEW_HEADER));

  const sub = runNova(["chain", "bogus"]);
  assert.equal(sub.code, 2);
  assert.match(sub.stderr, /nova chain \[list\|status\|abort\|pause\|resume\|clean\|verify\]/);
  assert.match(sub.stderr, /got "bogus"/);
  assert.ok(sub.stderr.includes(OVERVIEW_HEADER));

  // `--help` for a verb that does not exist is a usage error too, not a dump
  const bogusHelp = runNova(["chain", "create", "--help"]);
  assert.equal(bogusHelp.code, 2);
  assert.match(bogusHelp.stderr, /unknown verb "nova chain create"/);
  assert.ok(bogusHelp.stderr.includes("VERBS"), "the noun's own verb list is the answer");
  assert.ok(!bogusHelp.stderr.includes(OVERVIEW_HEADER), "not the whole manual");
});

test("every noun module's `switch (sub)` labels are in the verb table (a new verb cannot ship without help)", () => {
  const modules: Record<string, string> = {
    workspace: "workspace.ts",
    project: "project.ts",
    profile: "profile.ts",
    task: "task.ts",
    schedule: "schedule.ts",
    daemon: "daemon.ts",
    web: "web.ts",
    chain: "chain.ts",
    docs: "docs.ts",
  };
  for (const [noun, file] of Object.entries(modules)) {
    const source = readFileSync(join(REPO, "src", "cli", "commands", file), "utf8");
    const subs = [...source.matchAll(/^ {4}case "([a-z0-9-]+)":$/gm)].map((m) => m[1]!);
    assert.ok(subs.length > 0, `${file} has no sub switch (the parser changed shape)`);
    assert.deepEqual(
      subs.sort(),
      verbsOf(noun)
        .map((verb) => verb.sub)
        .filter((sub): sub is string => sub !== null)
        .sort(),
      `${file}'s cases and the verb table disagree`,
    );
  }
});

test("every READ verb supports --json (audited by walking the verb table)", () => {
  const readVerbs = VERBS.filter((verb) => verb.kind === "read");
  assert.ok(readVerbs.length >= 15, `the read surface shrank unexpectedly: ${readVerbs.length}`);
  for (const verb of readVerbs) {
    assert.equal(verb.json, true, `${verbKey(verb)} is a read verb without --json`);
    const res = runNova([...argvOf(verb), "--help"]);
    assert.ok(res.stdout.includes("--json"), `${verbKey(verb)} help does not advertise --json`);
  }
  // a server's stdout is its protocol channel: the one verb without --json
  const servers = VERBS.filter((verb) => verb.kind === "server");
  assert.deepEqual(servers.map(verbKey), ["nova mcp"]);
  assert.equal(servers[0]!.json, false);
});
