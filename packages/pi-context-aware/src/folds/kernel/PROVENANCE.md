# acp-kernel provenance

The files in this directory are the fold engine of [acp-kernel](https://github.com/ranxianglei/acp-kernel),
copied verbatim by `scripts/sync-acp-kernel.mjs`. Do not edit them here: change
the adapter in `src/folds/`, or sync a new upstream version.

| Field | Value |
| --- | --- |
| Package | `acp-kernel@0.0.101` |
| Repository | https://github.com/ranxianglei/acp-kernel.git |
| Commit | `4d38906e004e7fd9fe4b0c06cbd8c661694f506f` |
| Tarball integrity | `sha512-zKqi1mW+oTcpSY79lKkQXdz9AXFrmRj7JL6Mfpuo6JXM0WqRebXHBkQUZz9VGGi1SsOOjK0D9NghZ1/mIakdAA==` |
| Files copied | 60 |
| Files checked against the published source maps | 55 |
| Local changes | none |

Source-map verification covers only files embedded in `sourcesContent`.
Unmapped modules are pinned to the recorded source commit and type-checked,
but are not byte-compared with the tarball. See `src/folds/PROVENANCE.md`
for the coverage of the unmapped modules in this version.

Copied: every module reachable from the upstream root entrypoint `src/index.ts`.
Not copied: the separate `wire`, `panel` and `persist` entrypoints and any
module the root entrypoint does not import.

To update, run `node scripts/sync-acp-kernel.mjs <version>` with the exact
version, then review the diff and run the full check.

## Upstream license

The upstream license is MIT with an additional attribution term. It is
reproduced here unchanged.

```text
MIT License

Copyright (c) 2026 ranxianglei

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

Additional Term — Attribution on Product Surfaces
(在 MIT 之上附加的条款 —— 产品出处标注)

In addition to the conditions above, if you use or incorporate the Software
in a product or service that end users can see or interact with — whether
commercial or open source — you must make attribution clearly visible in at
least one of the following places:

  1. the product's home page;
  2. its documentation; or
  3. its "About" / "Credits" / "Acknowledgements" page.

The attribution must state that the product uses acp-kernel (and
billion-context, where applicable) and include a link to
https://github.com/ranxianglei/acp-kernel (and
https://github.com/ranxianglei/billion-context, where applicable).

For purely server-side or embedded uses with no user-facing surface, carrying
these notices in the shipped documentation satisfies this term.

附加条款（中文）：

除上述条件外，若将本软件用于任何终端用户可见或可交互的产品或服务（无论商业或开源），
须在下述至少一处显著位置标明出处：

  1. 产品首页；
  2. 产品文档；或
  3. “关于 / 致谢 / Acknowledgements”页面。

署名须说明该产品使用了 acp-kernel（涉及时包括 billion-context），并附指向
https://github.com/ranxianglei/acp-kernel （及 https://github.com/ranxianglei/billion-context，
涉及时）的链接。纯服务端或内嵌、无用户可见界面的用途，随附文档中包含上述声明即可。
```
