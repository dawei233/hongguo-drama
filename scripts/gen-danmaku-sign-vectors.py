#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从参考实现生成弹幕签名黄金向量（仅供开发期使用，不参与运行时）。

背景
----
`src/native/danmaku-sign.js` 是参考实现（guoapp 的 Go 版，以及 NAS 版的 Python 移植）
的 JavaScript 移植。签名算法（X-Gorgon / X-Ladon / X-Argus）没有任何官方文档，
只能靠与已验证可用的实现逐字节对齐来证明正确性。

本脚本把参考实现在**固定输入**下的输出冻成 JSON 向量，交给
`src/native/danmaku-sign.test.cjs` 断言 JS 侧复现同一结果。这样：
  - 日常测试不需要 Python，也不需要联网；
  - 向量来源可追溯（本脚本可随时重跑复现）。

用法
----
    python3 scripts/gen-danmaku-sign-vectors.py <参考实现目录>

其中 `<参考实现目录>` 是含 `danmaku.py` 的目录，例如
`../hongguo-monorepo/nas-backend`。工具只写入 stdout，请自行重定向。
"""

import json
import sys
import os

CASES = [
    # (stamp, stamp_ms, nonce_hex, aid)
    (1760000000, 1760000000000, "000102030405060708090a", "8662"),
    (1760000001, 1760000001000, "ffffffffffffffffffffff", "8662"),
    (1234567890, 1234567890123, "deadbeefcafebabe001122", "8662"),
]

DEVICE_ID = "1000000000000000001"
INSTALL_ID = "1000000000000000002"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    sys.path.insert(0, os.path.abspath(sys.argv[1]))

    import danmaku  # noqa: E402

    # 覆盖模块级设备指纹，让输出可复现
    danmaku._DEVICE_ID = DEVICE_ID
    danmaku._INSTALL_ID = INSTALL_ID

    vectors = []
    for stamp, stamp_ms, nonce_hex, aid in CASES:
        nonce = bytes.fromhex(nonce_hex)
        raw_query = danmaku._build_query(stamp_ms)
        headers = danmaku._sign_comment_headers(raw_query, stamp, nonce)
        vectors.append({
            "stamp": stamp,
            "stamp_ms": stamp_ms,
            "nonce_hex": nonce_hex,
            "aid": aid,
            "device_id": DEVICE_ID,
            "install_id": INSTALL_ID,
            "raw_query": raw_query,
            "x_gorgon": headers["X-Gorgon"],
            "x_ladon": headers["X-Ladon"],
            "x_argus": headers["X-Argus"],
            "x_khronos": headers["X-Khronos"],
            "x_ss_req_ticket": headers["X-SS-Req-Ticket"],
            "x_ss_stub": headers["X-SS-STUB"],
        })

    json.dump({"source": "nas-backend/danmaku.py", "vectors": vectors},
              sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
