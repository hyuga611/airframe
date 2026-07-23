// genchi のデモ：投入した"つもり"を、再取得で暴く。
//   node examples/db-insert.mjs
//
// 依存なしで動くよう、DB はメモリ上の作り物。実務では probe を
// 本物の再取得（SQLのcount、APIのGET、ファイルのstat 等）に差し替える。

import { gate, verify, expect, GenchiIncomplete } from '../src/index.mjs';

// --- 作り物のDB。drop:true のとき投入が"黙って"失敗する（＝現実の握りつぶされた失敗） ---
const table = [];
async function insert(rows, { drop = false } = {}) {
  if (drop) return; // 何もしないのに例外も投げない ＝ 一番タチが悪い失敗
  table.push(...rows);
}
const countBatch = (batch) => table.filter((r) => r.batch === batch).length;

async function run() {
  // ケース1：正常に投入 → 再取得で 2 件を確認 → 完了を名乗れる
  await insert([{ batch: 1 }, { batch: 1 }]);
  const n = await gate({
    action: 'batch=1 を2件投入',
    probe: () => countBatch(1),      // ← 行動の戻り値ではなく、実状態を"再取得"
    expect: expect.count(2),
  });
  console.log(`✓ 完了を名乗れる：再取得で ${n} 件を確認`);

  // ケース2：投入が黙って失敗 → 再取得は 0 件 → gate がブロック
  try {
    await insert([{ batch: 2 }, { batch: 2 }], { drop: true }); // 握りつぶされた失敗
    await gate({
      action: 'batch=2 を2件投入',
      probe: () => countBatch(2),
      expect: expect.count(2),
    });
    console.log('！ここには来ないはず（来たら「やったつもり」を見逃している）');
  } catch (e) {
    if (e instanceof GenchiIncomplete) {
      console.log(`✓ 「やったつもり」をブロック：${e.verdict.reason} / ${e.message.split('\n')[0]}`);
    } else throw e;
  }

  // ケース3：probe 自体が失敗 → 想像で成功にしない
  const v = await verify({
    action: 'DB接続して確認',
    probe: () => { throw new Error('connection refused'); },
  });
  console.log(`✓ probe失敗を握りつぶさない：ok=${v.ok} reason=${v.reason}`);
}

run();
