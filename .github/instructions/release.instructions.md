---
description: "发布与商店提交的硬约束：凭据私钥换行还原、manifest 描述 132 字符上限、同版本重复提交被拒、Edge 瞬时错误重试、无参数等于三端全发。Use when: 改 .dev/submit.mjs、提交文案或 manifest 描述，或排查上传失败、描述被拒、重复提交。"
applyTo:
  - ".dev/submit.mjs"
  - "public/_locales/**/messages.json"
  - "wxt.config.ts"
  - "package.json"
---

# 发布与商店提交

- 凭据在仓库根的 `.env.submit`（已 gitignore），`submit.mjs` 自己加载，缺项才从环境变量补。私钥在文件里是单行字面量 `\n`，必须还原成真实换行再交给 OpenSSL，否则 Chrome 上传必报 `DECODER routines::unsupported`。
- 商店简介取 manifest 的 `description`（即 `__MSG_appDescription__`），Chrome 与 Edge 都卡 132 字符，超了报 `PKG_MANIFEST_SUMMARY_TOO_LONG`。每个 locale 都要单独卡：改 `en` 时 `zh_CN` 一起核长度。
- 同一版本已在审核时再提交会被商店拒收，不会覆盖；要重发就换版本号，别在原地反复提交。
- Edge 上传偶发 `An error occurred while performing the operation` 且 `errors` 为 null，是后端瞬时错误：重传即可，别据此改包。
- 无参数运行 `node .dev/submit.mjs` 等于 `all`，会真的把三端全发；只想验证就走 `--dry-run` 并带具体商店名。
- 三端并行提交，某一端失败不影响其它端成功；Firefox 另需 `-sources.zip`，由 `wxt zip -b firefox --mv3` 一并产出，脚本自动挑选。
- 上架内容来自工作区构建，`v*` 标签不会自己跟随；发版前确认 HEAD 是否已超出上次标签。
