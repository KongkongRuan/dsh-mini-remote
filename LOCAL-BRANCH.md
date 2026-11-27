# 本机维护分支（local/0.2.5-ux）

这个仓库是 `dsh-mini-remote` 的完整源码，本机真正跑的那份插件原先是从 npm 装进
`~/.dsh/profiles/desktop/node_modules/dsh-mini-remote/` 的，所有改动都直接改在那里面——
**一次 `pnpm install` / 一次插件升级就会全丢**，而且没法 diff、没法回滚、没法跑仓库自带的测试。

所以这里开一条本地分支，把「本机实际在跑的那份代码」收进版本库。

## 这个分支是什么

- **基点**：upstream `tag v0.2.5`。已核对过：tag 的内容和 npm 发布的 0.2.5 包**一致**，
  只差换行符（tag 是 LF；npm 包与本机 `node_modules` 是 CRLF）。
  仓库 `.gitattributes` 强制 `eol=lf`，所以本分支里也是 LF。
- **内容**：
  1. 2026-11-27 之前的三处本机补丁（提问链 / 轮询兜底 / 底部抽屉）+ 固定公网入口；
  2. 2026-11-27 这一轮：答题回显（`role:'answer'` chip）、按轮分页（最近 3 轮 + 按需取）、
     以及顺手修掉的两个 bug（首屏被自动多铺一屏、完整模式过程组堆到页尾）；
  3. 2026-11-27 晚 v2（用户实机反馈后重做）：聊天模式的「思考」从「一行摘要」改成
     **过程清单**——整组默认折叠、展开是每一步（思考 + 工具步）、每步再展开才是正文；
     服务端多发 `step`（工具行）帧、`thought` 帧改发增量 + 步号；字号与块间距收一档。
- **提交信息里写了逐条改动和理由**；`git diff v0.2.5 HEAD` 就是「这台机器改了什么」的全集。

## 怎么把改动放到正在跑的那份里

现在 DSH 加载的仍然是 `node_modules` 里那一份，所以有两种走法。

### A. 先这么用（最稳，不碰 profile）

改完代码提交，然后把 `lib/` 覆盖过去，重启 DSH：

```powershell
$src = 'D:\project\DSH优化\dsh-mini-remote\lib'
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-mini-remote\lib"
Copy-Item "$src\*.js","$src\*.html" $dst -Force
# 手机页 2026-11-27 起拆成 lib/page/ 下的三份（shell.html / style.css / app.js），
# **这一行不能少**：只拷顶层的 *.js / *.html 会漏掉整个 page 目录，页面会读不到模板。
Copy-Item "$src\page" $dst -Recurse -Force
# 再重启 DSH（lib/page/ 那三份只在启动时读进内存）
```

回滚就是把 `~/.dsh/dsh-mini-remote/backup-*/` 里那份拷回去。

### B. 正式一点：让 profile 直接指向这个仓库（需要确认后做）

profile 的 `node_modules` 允许 `link:` 依赖（`dsh-boot-suite` 就是软链）。做法是改
`~/.dsh/profiles/desktop/package.json` 里 `dsh-mini-remote` 的版本为
`link:D:/project/DSH优化/dsh-mini-remote`，再 `pnpm install` + 重载插件。

好处：以后改完不用再拷文件。代价：`pnpm install` 会按 `link:` 重算依赖，profile 里那份
（含 `devices.json`、`state.json` 这些**数据**在 `~/.dsh/dsh-mini-remote/`，不在包里，安全）
之外的东西要提前备份 `package.json` / `pnpm-lock.yaml`。

## 远端

- `origin` = https://github.com/xingzhen199186/dsh-mini-remote.git（上游，**只读**：本机凭据对
  这个仓库没有写权限，`git push` 会被拒）
- `mine` = https://github.com/KongkongRuan/dsh-mini-remote.git（自己那份 fork，这条分支推在这儿）

```powershell
git push mine local/0.2.5-ux     # 推分支
git fetch origin --tags          # 拉上游的版本
```

## 每次改完要跑什么

1. 仓库自带测试（不需要装依赖就能跑的那几个）：
   ```powershell
   node --test test/history.test.mjs test/trajectory.test.mjs test/commands.test.mjs test/log-tail.test.mjs test/page.test.mjs
   ```
   `page.test.mjs` 是**按源码锚点切片**的，改 `lib/page/` 那三份时它会立刻报警——这正是
   2026-11-27 之前缺的那道保险。（它读的是拼回整份的页面，见 `test/page-source.mjs`。）
2. 项目目录里的离线靶场（浏览器 + 假 `EventSource`，不重启 DSH 就能验渲染）：
   `D:\project\DSH优化\手机遥控\verify\` 下五个 `mmr-*.mjs`。
3. `node --check` 每个改过的 `.js`，以及 `lib/page/app.js` 和 `lib/page/shell.html` 里那段内联脚本。

## 以后要跟上游升级

```powershell
git fetch origin --tags
git checkout -b local/0.2.7-fresh v0.2.7      # 或 main
git cherry-pick <本分支的提交>                  # 冲突主要会落在 lib/page/ / server.js
```
`0.2.6` 重写了中继、配对和 token（`relay-server/`、邀请码、HttpOnly cookie），
`pairing.js` 那一处补丁大概率要重写——升级时先看 `git diff v0.2.5 v0.2.6 -- lib/pairing.js`。

## 补丁文件还要吗

要。`..\手机遥控\dsh-mini-remote-local-0.2.5.patch` 是「0.2.5 → 本分支」的**导出**，
给「把干净的 0.2.5 重新装一遍、再打回本地改动」这种场景用；日常维护以本仓库的分支为准。
