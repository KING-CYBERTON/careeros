// CAREEROS (P6-C01): self-test for infra/production/preflight.sh, the check that refuses a production .env with a
// test or unsafe setting before deploy.sh starts anything. Runs in the careeros-ci static job (tooling/careeros glob).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "infra", "production", "preflight.sh");
const dir = mkdtempSync(join(tmpdir(), "careeros-preflight-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
function preflight(contents) {
	const file = join(dir, `env-${count++}`);
	writeFileSync(file, contents);
	const result = spawnSync("bash", [script, file], { encoding: "utf8" });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const safe = [
	'APP_URL="https://app.example.com"',
	'STRICT_SCHEMA_CHECK="true"',
	'BILLING_PROVIDER="paystack"',
	'PAYSTACK_SECRET_KEY="sk_live_abc"',
	'PAYSTACK_PUBLIC_KEY="pk_live_abc"',
	'PAYSTACK_ALLOW_TEST_KEY="false"',
	'FLAG_DISABLE_API_RATE_LIMIT="false"',
	"FLAG_ALLOW_UNSAFE_AI_BASE_URL=false",
].join("\n");

test("a safe production .env passes", () => {
	const result = preflight(`${safe}\n`);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /passed/);
	assert.equal(result.stderr, "");
});

test("the committed template passes", () => {
	const result = spawnSync("bash", [script, join(root, "infra", "production", ".env.production.example")], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
});

for (const [name, line] of [
	["PAYSTACK_ALLOW_TEST_KEY", 'PAYSTACK_ALLOW_TEST_KEY="true"'],
	["FLAG_DISABLE_API_RATE_LIMIT", "FLAG_DISABLE_API_RATE_LIMIT=1"],
	["FLAG_ALLOW_UNSAFE_AI_BASE_URL", "FLAG_ALLOW_UNSAFE_AI_BASE_URL='TRUE'"],
	["FLAG_ALLOW_UNSAFE_OAUTH_REDIRECT_URI", "export FLAG_ALLOW_UNSAFE_OAUTH_REDIRECT_URI=yes"],
	["FLAG_ALLOW_UNSAFE_ANYTHING_NEW", "FLAG_ALLOW_UNSAFE_ANYTHING_NEW=on"],
	["FLAG_ALLOW_FAKE_BILLING", "FLAG_ALLOW_FAKE_BILLING=true"],
	["PAYSTACK_SECRET_KEY", 'PAYSTACK_SECRET_KEY="sk_test_abc"'],
	["PAYSTACK_PUBLIC_KEY", "PAYSTACK_PUBLIC_KEY=pk_test_abc"],
	["BILLING_PROVIDER", "BILLING_PROVIDER=fake"],
]) {
	test(`refuses ${line}`, () => {
		const result = preflight(`${safe}\n${line}\n`);
		assert.equal(result.code, 1);
		assert.match(result.stderr, new RegExp(name));
	});
}

test("the last assignment of a name wins, as in Compose", () => {
	assert.equal(preflight(`${safe}\nPAYSTACK_ALLOW_TEST_KEY=true\nPAYSTACK_ALLOW_TEST_KEY=false\n`).code, 0);
	assert.equal(preflight(`PAYSTACK_ALLOW_TEST_KEY=false\n${safe}\nPAYSTACK_ALLOW_TEST_KEY=true\n`).code, 1);
});

test("comments, blank lines and CRLF line endings are handled", () => {
	assert.equal(preflight(`# FLAG_DISABLE_API_RATE_LIMIT=true\n\n${safe}\n`).code, 0);
	assert.equal(preflight(`${safe.replaceAll("\n", "\r\n")}\r\nFLAG_DISABLE_API_RATE_LIMIT=true\r\n`).code, 1);
});

test("never prints a secret value", () => {
	const result = preflight(`${safe}\nPAYSTACK_SECRET_KEY="sk_test_supersecretvalue"\n`);
	assert.equal(result.code, 1);
	assert.doesNotMatch(result.stdout + result.stderr, /supersecretvalue/);
});

test("warns but passes when STRICT_SCHEMA_CHECK is not true", () => {
	const result = preflight(safe.replace('STRICT_SCHEMA_CHECK="true"', 'STRICT_SCHEMA_CHECK="false"'));
	assert.equal(result.code, 0);
	assert.match(result.stderr, /STRICT_SCHEMA_CHECK/);
});

test("a missing file fails", () => {
	const result = spawnSync("bash", [script, join(dir, "does-not-exist")], { encoding: "utf8" });
	assert.equal(result.status, 1);
});
