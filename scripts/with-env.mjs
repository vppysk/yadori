// 環境変数ファイルを順に読み込み（後のファイルが優先）、続くコマンドを実行する。
// 例: node scripts/with-env.mjs .env.local .env.demo.local -- next dev
// （next dev は node の --env-file を子プロセスの NODE_OPTIONS に渡せないため、ここで読み込んでから起動する）
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const sep = process.argv.indexOf("--");
const files = process.argv.slice(2, sep);
const [command, ...args] = process.argv.slice(sep + 1);
const env = { ...process.env };
for (const file of files) {
  if (existsSync(file)) Object.assign(env, parseEnv(readFileSync(file, "utf8")));
}
const child = spawn(command, args, { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
