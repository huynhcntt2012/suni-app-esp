const $=s=>document.querySelector(s);
let state=null, register=false, loading=false, stale=false;
const days=['CN','T2','T3','T4','T5','T6','T7'];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=t=>new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'short',timeStyle:'medium'}).format(t);
const labels={queued:'Đang chờ',delivered:'Đã gửi · chờ phản hồi',completed:'Đã hoàn tất',expired:'Lệnh hết hạn',unknown:'Chưa rõ kết quả',skipped:'Bỏ qua · chưa sẵn sàng',interrupted:'Bị ngắt · cần kiểm tra',cancelled:'Đã hủy · đổi cấu hình'};
async function api(p,method='GET',body){const r=await fetch('/api'+p,{method,headers:{'Content-Type':'application/json','X-Requested-With':'PawMeal'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok){const e=new Error(data.error||'Không thể thực hiện.');e.status=r.status;throw e;}return data;}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,5000);}
function authView(){state=null;$('#dashboard').hidden=true;$('#auth').hidden=false;$('#add-device').hidden=true;$('#account').replaceChildren();}
async function refresh(){if(loading)return;loading=true;try{state=await api('/state');stale=false;render();}catch(e){if(e.status===401)authView();else{stale=true;$('#updated').textContent='Mất kết nối máy chủ';document.querySelectorAll('.feed').forEach(b=>b.disabled=true);}}finally{loading=false;}}
function syncMessage(d){
  if(d.firmware_protocol!==4)return 'Cần nạp firmware quét theo thời gian mới';
  if(d.config_error)return 'ESP32 chưa lưu được cấu hình · đang thử lại';
  if(d.config_synced)return 'Đã lưu cấu hình trên ESP32';
  if(!d.online)return 'Chờ thiết bị kết nối để đồng bộ';
  return 'Đang chờ ESP32 xác nhận cấu hình';
}
function render(){
  $('#auth').hidden=true;$('#dashboard').hidden=false;$('#add-device').hidden=false;
  $('#account').innerHTML=`<div>${esc(state.user.email)}</div><button id="logout">Đăng xuất</button>`;
  $('#logout').onclick=async()=>{try{await api('/logout','POST');$('#modal').close();authView();}catch(e){toast(e.message);}};
  $('#total').textContent=state.devices.length;$('#online').textContent=state.devices.filter(d=>d.online).length;$('#schedules-total').textContent=state.devices.flatMap(d=>d.schedules).filter(s=>s.enabled).length;$('#updated').textContent='Cập nhật '+new Date().toLocaleTimeString('vi-VN');
  $('#devices').innerHTML=state.devices.length?state.devices.map(d=>`<article class="device"><div class="device-head"><div><h3>${esc(d.name)}</h3><p>MG996R · quét theo thời gian · Thiết bị #${d.id}</p></div><span class="status ${d.online?'live':''}">${d.online?'Đã kết nối':'Mất kết nối'}</span></div><div class="device-metric"><div><strong>${d.portions}</strong> <span>phần / lần ăn</span><small class="portion-detail">${d.portion_ms/1000} giây/phần · Tổng ${d.run_ms/1000} giây<br>Mốc ${d.closed_angle} ↔ ${d.open_angle} · Hết giờ về A</small></div><span>${d.schedules.filter(s=>s.enabled).length} lịch đang bật</span></div><p class="sync-state ${d.config_synced?'synced':'pending'}">${syncMessage(d)}</p><div class="schedule-list">${d.schedules.length?d.schedules.map(s=>`<div class="schedule-row ${s.enabled?'':'off'}"><div><strong>${s.time}</strong><small>${s.days.length===7?'Mỗi ngày':s.days.map(v=>days[v]).join(' · ')}</small></div><div class="schedule-actions"><button class="secondary" data-action="toggle" data-id="${d.id}" data-sid="${s.id}" aria-label="${s.enabled?'Tắt':'Bật'} lịch ${s.time}">${s.enabled?'Đang bật':'Đang tắt'}</button><button class="secondary" data-action="remove-schedule" data-id="${d.id}" data-sid="${s.id}" aria-label="Xóa lịch ${s.time}">×</button></div></div>`).join(''):'<p class="muted">Chưa có lịch. Thêm giờ ăn đầu tiên.</p>'}</div><button class="text-btn" data-action="schedule" data-id="${d.id}">+ Thêm lịch cho ăn</button><div class="actions"><button class="feed" data-action="feed" data-id="${d.id}" ${!d.online||!d.config_synced||d.firmware_protocol!==4?'disabled':''}>Cho ăn ngay</button><button class="secondary" data-action="settings" data-id="${d.id}">Cài đặt</button></div></article>`).join(''):'<div class="empty"><h3>Sẵn sàng cho bữa ăn đầu tiên</h3><p>Thêm máy cho ăn để lấy mã kết nối ESP32.<br>Thiết bị sẽ hiện trực tuyến sau khi được nạp mã và kết nối Wi-Fi.</p><button data-action="add">+ Thêm thiết bị</button></div>';
  $('#events').innerHTML=state.events.length?state.events.map(e=>`<tr><td>${date(e.created)}</td><td>${esc(e.name)}</td><td>${e.source==='manual'?'Thủ công':'Theo lịch'}</td><td>${e.run_ms?e.portions+(e.servo_mode==='timed_sweep'?' phần':e.servo_mode==='position180'?' chu kỳ (cũ)':' phần (cũ)'):'—'}</td><td>${e.run_ms?e.run_ms/1000+' giây':'—'}</td><td><span class="status ${e.status==='completed'?'live':''}">${labels[e.status]||esc(e.status)}</span></td></tr>`).join(''):'<tr><td colspan="6">Chưa có hoạt động cho ăn.</td></tr>';
}
function modal(title,html){$('#modal-title').textContent=title;$('#modal-body').innerHTML=html;$('#modal-error').textContent='';if(!$('#modal').open)$('#modal').showModal();}
$('#close-modal').onclick=()=>$('#modal').close();
function bindForm(handler){$('#modal-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('#modal-error').textContent='';try{await handler(new FormData(e.target));await refresh();}catch(error){$('#modal-error').textContent=error.message;}finally{b.disabled=false;}};}
function showToken(secret){modal('Mã kết nối thiết bị',`<p>Lưu mã này vào <b>DEVICE_TOKEN</b> trong tệp cấu hình ESP32. Mã chỉ hiển thị một lần; không chia sẻ với người khác.</p><div class="secret">${esc(secret)}</div><p class="muted">Đặt SERVER_URL thành địa chỉ máy chủ mà ESP32 truy cập được, ví dụ http://192.168.1.10:3000 trên Wi-Fi riêng. Xem README.md để nạp firmware.</p><button id="token-done">Đã lưu mã</button>`);$('#token-done').onclick=()=>$('#modal').close();}
function addDevice(){modal('Thêm máy cho ăn',`<form id="modal-form"><label>Tên thiết bị<input name="name" placeholder="Ví dụ: Máy của Miu" maxlength="60" required autofocus></label><p class="muted">Mỗi máy có một mã kết nối riêng và thuộc tài khoản của bạn.</p><button>Tạo thiết bị</button></form>`);bindForm(async f=>showToken((await api('/devices','POST',{name:f.get('name')})).token));}
$('#add-device').onclick=addDevice;
$('#auth-switch').onclick=()=>{register=!register;$('#auth-title').textContent=$('#auth-submit').textContent=register?'Tạo tài khoản':'Đăng nhập';$('#auth-switch').textContent=register?'Đã có tài khoản? Đăng nhập':'Chưa có tài khoản? Đăng ký';$('#auth-form [name=password]').autocomplete=register?'new-password':'current-password';$('#auth-error').textContent='';};
$('#auth-form').onsubmit=async e=>{e.preventDefault();$('#auth-submit').disabled=true;$('#auth-error').textContent='';try{await api(register?'/register':'/login','POST',Object.fromEntries(new FormData(e.target)));e.target.reset();await refresh();}catch(error){$('#auth-error').textContent=error.message;}finally{$('#auth-submit').disabled=false;}};
$('#devices').onclick=async e=>{
  const b=e.target.closest('button[data-action]');if(!b)return;
  const d=state.devices.find(d=>d.id===Number(b.dataset.id)), action=b.dataset.action;b.disabled=true;
  try{
    if(action==='add')addDevice();
    if(action==='feed'){if(stale)throw new Error('Chưa kết nối được máy chủ.');await api(`/devices/${d.id}/feed`,'POST');toast('Đã tạo lệnh cho ăn. Theo dõi phản hồi trong nhật ký.');}
    if(action==='toggle'){const s=d.schedules.find(s=>s.id===Number(b.dataset.sid));await api(`/devices/${d.id}/schedules/${s.id}`,'PATCH',{enabled:!s.enabled});}
    if(action==='remove-schedule')await api(`/devices/${d.id}/schedules/${b.dataset.sid}`,'DELETE');
    if(action==='schedule'){
      modal('Thêm lịch · '+d.name,`<form id="modal-form"><label>Giờ cho ăn · Việt Nam (UTC+7)<input name="time" type="time" value="07:00" required></label><p>Ngày trong tuần</p><div class="days">${days.map((v,i)=>`<label><input type="checkbox" name="days" value="${i}" checked>${v}</label>`).join('')}</div><p class="muted">Mỗi lần quét qua lại ${d.portions} × ${d.portion_ms/1000} = ${d.run_ms/1000} giây, sau đó về A rồi dừng. Máy chủ và ESP32 cần hoạt động đúng giờ. Lịch bị lỡ sẽ không chạy bù.</p><button>Thêm lịch</button></form>`);
      bindForm(async f=>{await api(`/devices/${d.id}/schedules`,'POST',{time:f.get('time'),days:f.getAll('days').map(Number)});$('#modal').close();toast('Đã thêm lịch cho ăn.');});
    }
    if(action==='settings'){
      modal('Cài đặt thiết bị',`<form id="modal-form"><label>Tên thiết bị<input name="name" value="${esc(d.name)}" maxlength="60" required></label><div class="form-row"><label>Số phần mỗi lần ăn<input name="portions" type="number" min="1" max="20" step="1" value="${d.portions}" required></label><label>Thời gian chạy / phần (giây)<input name="portion_seconds" type="number" min="0.2" max="10" step="0.001" value="${d.portion_ms/1000}" required></label></div><p id="portion-preview" class="portion-preview" aria-live="polite"></p><div class="form-row"><label>Mốc A / vị trí dừng (0–360)<input name="closed_angle" type="number" min="0" max="360" step="1" value="${d.closed_angle}" required></label><label>Mốc B (0–360)<input name="open_angle" type="number" min="0" max="360" step="1" value="${d.open_angle}" required></label></div><label>Nghỉ ở mỗi đầu (giây)<input name="move_seconds" type="number" min="0.2" max="3" step="0.001" value="${d.move_ms/1000}" required></label><p class="muted">Quét A ↔ B, bước 5 mỗi 5 ms, đến hết tổng thời gian rồi về A và dừng. Thời gian nghỉ ở hai đầu nằm trong tổng thời gian chạy. Đoạn về A mất thêm tối đa khoảng 0,36 giây. Mốc 0–360 theo bản test: 0 = 1000 µs, 180 = 2000 µs, 360 = 3000 µs; không phải góc trục đo được. Chỉ dùng dải đã kiểm tra trên servo của bạn. Tổng tối đa 60 giây/lệnh. Lưu không làm servo di chuyển; lệnh đang chờ bị hủy, lệnh đã gửi vẫn hoàn tất theo cấu hình cũ.</p><button>Lưu và đồng bộ ESP32</button></form><div class="form-end"><button class="secondary" id="rotate-token">Cấp lại mã kết nối</button><button class="danger" id="delete-device">Xóa thiết bị</button></div>`);
      const updatePreview=()=>{
        const qty=$('#modal-form [name=portions]'), duration=$('#modal-form [name=portion_seconds]');
        const count=Number(qty.value), ms=Math.round(Number(duration.value)*1000), total=count*ms;
        qty.setCustomValidity(total>60000?'Tổng thời gian không được quá 60 giây.':'');
        $('#portion-preview').textContent=Number.isFinite(total)&&total>0?count+' phần × '+ms/1000+' giây = '+total/1000+' giây quét, sau đó về A':'Nhập số phần và thời gian.';
        $('#portion-preview').classList.toggle('invalid',total>60000);
      };
      $('#modal-form [name=portions]').oninput=updatePreview;
      $('#modal-form [name=portion_seconds]').oninput=updatePreview;
      $('#modal-form [name=move_seconds]').oninput=updatePreview;
      updatePreview();
      bindForm(async f=>{const result=await api(`/devices/${d.id}`,'PATCH',{name:f.get('name'),portions:Number(f.get('portions')),portion_ms:Math.round(Number(f.get('portion_seconds'))*1000),closed_angle:Number(f.get('closed_angle')),open_angle:Number(f.get('open_angle')),move_ms:Math.round(Number(f.get('move_seconds'))*1000)});$('#modal').close();toast(result.config_synced?'Cấu hình đã được ESP32 xác nhận.':'Đã lưu trên máy chủ. Đang chờ ESP32 xác nhận.');});
      $('#rotate-token').onclick=()=>{modal('Cấp lại mã kết nối?',`<p>Mã cũ sẽ hết hiệu lực. Bạn cần cập nhật cấu hình và nạp lại ESP32.</p><form id="modal-form"><button>Cấp mã mới</button></form>`);bindForm(async()=>showToken((await api(`/devices/${d.id}/token`,'POST')).token));};
      $('#delete-device').onclick=()=>{modal('Xóa '+d.name+'?',`<p>Xóa thiết bị, các lịch và nhật ký của máy này khỏi tài khoản. Lệnh đã gửi tới máy có thể vẫn hoàn tất.</p><form id="modal-form"><button class="danger">Xóa thiết bị</button></form>`);bindForm(async()=>{await api(`/devices/${d.id}`,'DELETE');$('#modal').close();});};
    }
    await refresh();
  }catch(error){toast(error.message);}finally{b.disabled=false;}
};
refresh();setInterval(refresh,5000);
