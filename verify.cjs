/* 自动化验证脚本：驱动系统 Edge 验证核心交互（不调用真实生图 API） */
const { chromium } = require("playwright-core");
const fs = require("fs");

const results = [];
const check = (name, cond) => results.push((cond ? "PASS" : "FAIL") + "  " + name);

(async () => {
  fs.writeFileSync(
    "test-input.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded" });
  await page.getByText("文生图", { exact: true }).first().waitFor({ timeout: 15000 });
  check("boot 完成，主界面渲染", true);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "shot-1-home-dark.png" });

  // 新建窗口（网格末尾的添加块）
  await page.getByRole("button", { name: "新窗口" }).last().click();
  await page.waitForTimeout(800);
  check("新建窗口后有 2 个工作区", (await page.locator("[data-ws]").count()) === 2);

  // 第二个窗口切图生图并上传
  const ws2 = page.locator("[data-ws]").nth(1);
  await ws2.getByRole("button", { name: "图生图" }).click();
  await page.waitForTimeout(500);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    ws2.locator("button[data-tip='选择图片']").click(),
  ]);
  await chooser.setFiles("test-input.png");
  await page.waitForTimeout(1000);
  check("输入图缩略图已显示", (await ws2.locator("img[alt='test-input.png']").count()) === 1);

  // 空 prompt 校验（不触发真实 API）
  await ws2.getByRole("button", { name: /开始图生图/ }).click();
  await page.waitForTimeout(400);
  check("空 prompt 校验提示", (await ws2.getByText("请填写 prompt").count()) >= 1);
  await page.screenshot({ path: "shot-2-edit-mode.png" });

  // 命令面板
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("输入命令…").waitFor({ timeout: 4000 });
  check("Ctrl+K 打开命令面板", true);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "shot-3-palette.png" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("Esc 关闭命令面板", (await page.getByPlaceholder("输入命令…").count()) === 0);

  // 画廊
  await page.keyboard.press("g");
  await page.getByText("还没有生成过图片").waitFor({ timeout: 4000 });
  check("G 打开画廊（空态）", true);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "shot-4-gallery.png" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // Prompt 库
  await page.keyboard.press("p");
  await page.getByPlaceholder("输入新的 prompt 加入收藏…").waitFor({ timeout: 4000 });
  await page
    .getByPlaceholder("输入新的 prompt 加入收藏…")
    .fill("赛博朋克城市夜景，霓虹倒映在湿润街道");
  await page.getByRole("button", { name: "添加" }).click();
  await page.waitForTimeout(600);
  check("Prompt 收藏添加成功", (await page.getByText("赛博朋克城市夜景").count()) >= 1);
  await page.screenshot({ path: "shot-5-promptlib.png" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 主题切换
  await page.locator("button[data-tip='切换浅色']").click();
  await page.waitForTimeout(1200);
  check(
    "切换到浅色主题",
    (await page.evaluate(() => document.documentElement.dataset.theme)) === "light",
  );
  await page.screenshot({ path: "shot-6-light.png" });
  await page.locator("button[data-tip='切换深色']").click();
  await page.waitForTimeout(1000);

  // 刷新持久化（工作区与输入图来自 IndexedDB）
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("文生图", { exact: true }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1400);
  check("刷新后工作区仍为 2 个", (await page.locator("[data-ws]").count()) === 2);
  check(
    "刷新后输入图已恢复",
    (await page.locator("img[alt='test-input.png']").count()) === 1,
  );
  check("主题偏好已持久化（深色）", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");

  console.log(results.join("\n"));
  console.log(errors.length ? "JS ERRORS:\n" + errors.join("\n") : "JS ERRORS: 无");
  await browser.close();
})().catch((e) => {
  console.error("VERIFY CRASH:", e);
  process.exit(1);
});
