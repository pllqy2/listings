// 매물 소개 페이지 Worker — 정적 파일(assets)은 그대로 서빙하고,
// /api/listing/:code 와 /edit/:code 두 경로만 가로채서 KV 기반 실시간 편집을 지원한다.
// (2026-08-27 추가 — 사용자 요청: "share 내용을 URL 타고 들어가서 수정할 수 있게")
//
// 데이터 흐름:
//   1. run_share(파이썬)가 새 매물을 만들 때 KV(LISTING_DATA)에도 같은 내용을 심어둔다.
//   2. listings_N.html이 로드되면, 각 카드가 자기 sCode로 /api/listing/:code를 조회해서
//      KV에 더 최신 데이터가 있으면 화면(카드+상세페이지)을 그걸로 덮어쓴다.
//   3. /edit/:code?key=비밀번호 로 들어가면 편집 폼이 뜨고, 저장하면 KV가 바로 갱신된다 —
//      git push나 재배포 없이 사이트에 즉시 반영됨.
//   4. 비밀번호(EDIT_PASSWORD)는 wrangler secret으로 저장 — 코드에 평문으로 넣지 않는다.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const apiMatch = path.match(/^\/api\/listing\/(S\d+)$/);
    if (apiMatch) return handleApi(request, env, apiMatch[1]);

    const editMatch = path.match(/^\/edit\/(S\d+)\/?$/);
    if (editMatch) return handleEdit(request, env, editMatch[1]);

    // 그 외 전부: 기존 정적 자산(HTML/이미지 등) 그대로
    return env.ASSETS.fetch(request);
  },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Edit-Key",
};

async function handleApi(request, env, code) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method === "GET") {
    const data = await env.LISTING_DATA.get(code);
    if (!data) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    return new Response(data, {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  if (request.method === "POST") {
    const key = request.headers.get("X-Edit-Key") || new URL(request.url).searchParams.get("key");
    if (!env.EDIT_PASSWORD || key !== env.EDIT_PASSWORD) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    // 저장 항목 화이트리스트 — 사진/구조적 필드는 편집 대상이 아니므로 임의 키 주입 방지
    const ALLOWED = ["tag", "title", "price", "desc", "info", "features", "memo", "phone", "agency", "agent"];
    const clean = {};
    for (const k of ALLOWED) if (k in body) clean[k] = body[k];
    await env.LISTING_DATA.put(code, JSON.stringify(clean));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  return new Response("Method Not Allowed", { status: 405 });
}

async function handleEdit(request, env, code) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";

  if (!env.EDIT_PASSWORD || key !== env.EDIT_PASSWORD) {
    return new Response(renderLoginPage(code, request.method === "POST"), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const raw = await env.LISTING_DATA.get(code);
  if (!raw) {
    return new Response(`매물 데이터를 찾을 수 없습니다 (${code})`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const data = JSON.parse(raw);
  return new Response(renderEditPage(code, data, key), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderLoginPage(code, wrongPw) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>매물 수정 - ${code}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;background:#f3f4f6;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  form{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:280px}
  h2{margin:0 0 16px;font-size:18px;color:#222}
  input{width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:15px}
  button{width:100%;margin-top:12px;padding:10px;background:#2563eb;color:#fff;border:none;
         border-radius:6px;font-size:15px;cursor:pointer}
  .err{color:#dc2626;font-size:13px;margin-top:8px}
</style></head><body>
<form method="get" action="/edit/${code}">
  <h2>${code} 매물 수정</h2>
  <input type="password" name="key" placeholder="비밀번호" autofocus required>
  <button type="submit">확인</button>
  ${wrongPw ? '<div class="err">비밀번호가 틀렸습니다.</div>' : ''}
</form>
</body></html>`;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderEditPage(code, data, key) {
  const info = data.info || [];
  const features = data.features || [];
  const infoRows = info.map((r, i) => `
    <div class="row" data-idx="${i}">
      <input class="info-label" value="${esc(r.label)}" placeholder="항목명">
      <input class="info-value" value="${esc(r.value)}" placeholder="내용">
      <button type="button" class="del" onclick="this.parentElement.remove()">✕</button>
    </div>`).join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${code} 수정</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;background:#f3f4f6;
       margin:0;padding:20px;color:#222}
  .wrap{max-width:520px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .hint{color:#888;font-size:13px;margin-bottom:20px}
  .card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 6px rgba(0,0,0,.06)}
  label{display:block;font-size:13px;color:#555;margin:14px 0 6px;font-weight:600}
  label:first-child{margin-top:0}
  input[type=text], input:not([type]), textarea{
    width:100%;padding:9px 10px;border:1px solid #ddd;border-radius:6px;
    box-sizing:border-box;font-size:14px;font-family:inherit}
  textarea{min-height:70px;resize:vertical}
  .row{display:flex;gap:6px;margin-bottom:6px}
  .row input{flex:1}
  .row .del{flex:0 0 auto;background:#fee2e2;color:#dc2626;border:none;border-radius:6px;
            width:32px;cursor:pointer;font-size:14px}
  .addBtn{background:#eef2ff;color:#3730a3;border:none;border-radius:6px;padding:8px 12px;
          font-size:13px;cursor:pointer;margin-top:4px}
  .save{position:sticky;bottom:16px;width:100%;padding:14px;background:#2563eb;color:#fff;
        border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;
        box-shadow:0 4px 14px rgba(37,99,235,.35)}
  .save:disabled{background:#93b4f0;cursor:default}
  #msg{text-align:center;margin-top:10px;font-size:14px}
  #msg.ok{color:#16a34a}
  #msg.err{color:#dc2626}
</style></head><body>
<div class="wrap">
  <h1>${code} 매물 수정</h1>
  <div class="hint">저장하면 사이트에 바로 반영됩니다. 사진은 여기서 수정할 수 없습니다.</div>

  <div class="card">
    <label>태그 (예: 투룸)</label>
    <input id="f_tag" value="${esc(data.tag)}">
    <label>카드 제목</label>
    <input id="f_title" value="${esc(data.title)}">
    <label>가격 (상세페이지용, 예: 보증금 2000만 / 월세 60만)</label>
    <input id="f_price" value="${esc(data.price)}">
    <label>카드 설명 (예: 관리비 5만원 · 투룸 · 총 4층)</label>
    <input id="f_desc" value="${esc(data.desc)}">
  </div>

  <div class="card">
    <label>상세 정보</label>
    <div id="infoRows">${infoRows}</div>
    <button type="button" class="addBtn" onclick="addInfoRow()">+ 항목 추가</button>
  </div>

  <div class="card">
    <label>특징 태그 (쉼표로 구분)</label>
    <input id="f_features" value="${esc(features.join(", "))}">
    <label>중개사 한줄 메모</label>
    <textarea id="f_memo">${esc(data.memo)}</textarea>
    <label>연락처</label>
    <input id="f_phone" value="${esc(data.phone)}">
    <label>중개사무소명</label>
    <input id="f_agency" value="${esc(data.agency)}">
    <label>담당자명</label>
    <input id="f_agent" value="${esc(data.agent)}">
  </div>

  <button class="save" id="saveBtn" onclick="save()">저장</button>
  <div id="msg"></div>
</div>

<script>
function addInfoRow() {
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = '<input class="info-label" placeholder="항목명"><input class="info-value" placeholder="내용">' +
                  '<button type="button" class="del" onclick="this.parentElement.remove()">✕</button>';
  document.getElementById('infoRows').appendChild(div);
}

async function save() {
  const btn = document.getElementById('saveBtn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  msg.textContent = '';
  msg.className = '';

  const info = Array.from(document.querySelectorAll('#infoRows .row')).map(row => ({
    label: row.querySelector('.info-label').value.trim(),
    value: row.querySelector('.info-value').value.trim(),
  })).filter(r => r.label);

  const payload = {
    tag: document.getElementById('f_tag').value,
    title: document.getElementById('f_title').value,
    price: document.getElementById('f_price').value,
    desc: document.getElementById('f_desc').value,
    info,
    features: document.getElementById('f_features').value.split(',').map(s => s.trim()).filter(Boolean),
    memo: document.getElementById('f_memo').value,
    phone: document.getElementById('f_phone').value,
    agency: document.getElementById('f_agency').value,
    agent: document.getElementById('f_agent').value,
  };

  try {
    const res = await fetch('/api/listing/${code}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Key': ${JSON.stringify(key)} },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (res.ok && j.ok) {
      msg.textContent = '✓ 저장 완료';
      msg.className = 'ok';
    } else {
      msg.textContent = '저장 실패: ' + (j.error || res.status);
      msg.className = 'err';
    }
  } catch (e) {
    msg.textContent = '저장 실패: ' + e;
    msg.className = 'err';
  }
  btn.disabled = false;
}
</script>
</body></html>`;
}
