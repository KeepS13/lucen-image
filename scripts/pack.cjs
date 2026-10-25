/**
 * 生成可部署的 npm 发布包。
 *
 * npm pack --pack-destination 在目标目录不存在时会直接失败，
 * 因此这里先显式创建 release/，保证本地与 CI 行为一致。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release");
fs.mkdirSync(releaseDir, { recursive: true });

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--pack-destination", "release"],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.error) {
  console.error("无法执行 npm pack：" + result.error.message);
  process.exit(1);
}
process.exit(result.status || 0);
