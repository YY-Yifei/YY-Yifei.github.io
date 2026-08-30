/**
 * Atlas 地图标记系统 — 高德 JS API 2.0 引擎版
 * 数据驱动：场景索引 data/scenes.json + 每个场景独立 JSON
 * 坐标：场景数据存 WGS-84，显示时转 GCJ-02（高德坐标系）
 * 功能：场景标记/连线 · POI 搜索 · 卫星底图
 */

/* ========== 坐标系转换：WGS-84 → GCJ-02（中国境内） ========== */
const PI = Math.PI;
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lat, lng) {
  return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/** 坐标系转换：GCJ-02 → WGS-84（中国境内，反向迭代） */
function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng };
  const p = wgs84ToGcj02(lat, lng);
  return { lat: lat - (p.lat - lat), lng: lng - (p.lng - lng) };
}

/** 数据坐标 (lat, lng, WGS-84) → 高德坐标 [lng, lat]（GCJ-02） */
function toAMap(lat, lng) {
  const p = wgs84ToGcj02(lat, lng);
  return [p.lng, p.lat];
}

/* ========== 常量 ========== */
const NODE_COLORS = {
  terminal: '#e74c3c',   // 终点/起点
  station:  '#3498db',   // 普通站点
  hub:      '#f39c12',   // 枢纽
  landmark: '#9b59b6',   // 地标
  border:   '#2ecc71',   // 口岸/边界
  default:  '#64748b',
};

/* ========== 地图初始化 ========== */
if (typeof AMap === 'undefined') {
  document.getElementById('scene-list').innerHTML =
    '<p class="loading">⚠️ 高德地图 SDK 加载失败（检查 key / 域名白名单）</p>';
  throw new Error('AMap SDK not loaded');
}

const map = new AMap.Map('map', {
  zoom: 5,
  center: [103.0, 24.0], // 默认视角：云南一带
  viewMode: '2D',
  doubleClickZoom: false, // 双击用于获取坐标，缩放用滚轮/按钮
});

// 移动端窄屏默认收起侧边栏（须在地图初始化后、首次绘制前设置布局）
if (window.innerWidth <= 600) {
  document.body.classList.add('sidebar-collapsed');
}

/* 图层（懒加载，避免初始化开销） */
let satLayer = null;
let roadNetLayer = null;
let satOn = false;

function setBaseMode(mode) {
  if (mode === 'satellite') {
    if (!satOn) {
      if (!satLayer) satLayer = new AMap.TileLayer.Satellite();
      if (!roadNetLayer) roadNetLayer = new AMap.TileLayer.RoadNet();
      map.add([satLayer, roadNetLayer]);
      satOn = true;
    }
  } else if (satOn) {
    map.remove([satLayer, roadNetLayer]);
    satOn = false;
  }
  document.querySelectorAll('.lc-btn[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
}

/* ========== 场景管理 ========== */
let scenes = [];
let currentScene = null;
let currentLayers = [];
let poiMarkers = [];
let infoWindow = null;

/** 加载场景索引 */
async function loadScenes() {
  try {
    const res = await fetch('data/scenes.json', { cache: 'no-store' });
    scenes = (await res.json()).scenes;
    renderSceneList();
  } catch (err) {
    document.getElementById('scene-list').innerHTML =
      `<p class="loading">⚠️ 场景列表加载失败：${err.message}</p>`;
  }
}

/** 渲染侧边栏场景列表 */
function renderSceneList() {
  const list = document.getElementById('scene-list');
  list.innerHTML = '';
  scenes.forEach((scene, i) => {
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.innerHTML = `
      <div class="scene-name">${scene.name}</div>
      <div class="scene-desc">${scene.description || ''}</div>
      <div class="scene-tags">${(scene.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}</div>
    `;
    card.onclick = (e) => selectScene(scene, e.currentTarget);
    list.appendChild(card);
  });
}

/** 选择场景并加载数据 */
async function selectScene(scene, activeCard) {
  document.querySelectorAll('.scene-card').forEach(c => c.classList.remove('active'));
  if (activeCard) activeCard.classList.add('active');

  clearLayers();
  currentScene = scene;
  const data = await fetchSceneData(scene.dataFile);

  // 设置默认视角（数据 view.center 为 [lat, lng]）
  if (data.view) {
    map.setZoomAndCenter(data.view.zoom, toAMap(data.view.center[0], data.view.center[1]));
  }

  // 画连线（先画线，节点盖在上面）
  (data.lines || []).forEach(line => drawLine(line, data.nodes));

  // 画节点
  (data.nodes || []).forEach(node => drawNode(node));

  // 信息面板
  showSceneInfo(data, scene);
}

async function fetchSceneData(file) {
  try {
    const res = await fetch(file, { cache: 'no-store' });
    return await res.json();
  } catch (err) {
    console.error('场景数据加载失败:', file, err);
    alert(`场景数据加载失败: ${file}`);
    return { nodes: [], lines: [] };
  }
}

/** 清空当前图层（场景覆盖物 + POI + 弹窗） */
function clearLayers() {
  currentLayers.forEach(l => map.remove(l));
  currentLayers = [];
  clearPoi();
  if (infoWindow) infoWindow.close();
}

/** 清空 POI 搜索结果 */
function clearPoi() {
  poiMarkers.forEach(m => map.remove(m));
  poiMarkers = [];
}

/** 画节点标记 */
function drawNode(node) {
  const color = NODE_COLORS[node.type] || NODE_COLORS.default;
  const label = node.label || node.name.charAt(0);
  const html = `<div style="width:26px;height:26px;background:${color};border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:bold;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${label}</div>`;

  const marker = new AMap.Marker({
    position: toAMap(node.lat, node.lng),
    content: html,
    anchor: 'center',
  });

  marker.on('click', () => {
    const content = `<div style="font-size:13px;line-height:1.6;min-width:170px">
      <b style="font-size:14px">${node.name}</b><br>
      <span style="color:#888">${node.typeLabel || node.type}</span><br>
      ${node.description || ''}
    </div>`;
    if (!infoWindow) infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -8) });
    infoWindow.setContent(content);
    infoWindow.open(map, toAMap(node.lat, node.lng));
  });

  map.add(marker);
  currentLayers.push(marker);
}

/** 画连线 */
function drawLine(line, nodes) {
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  const path = (line.path || [])
    .map(id => nodeMap[id])
    .filter(n => n)
    .map(n => toAMap(n.lat, n.lng));

  if (path.length < 2) return;

  const polyline = new AMap.Polyline({
    path,
    strokeColor: line.color || '#e74c3c',
    strokeWeight: 4,
    strokeOpacity: 0.85,
    lineJoin: 'round',
    lineCap: 'round',
    ...(line.dashed ? { strokeStyle: 'dashed' } : {}),
  });

  polyline.on('click', () => {
    const content = `<div style="font-size:13px;padding:2px 4px"><b>${line.name}</b></div>`;
    if (!infoWindow) infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -8) });
    infoWindow.setContent(content);
    infoWindow.open(map, path[Math.floor(path.length / 2)]);
  });

  map.add(polyline);
  currentLayers.push(polyline);
}

/** 显示场景信息面板 */
function showSceneInfo(data, scene) {
  const panel = document.getElementById('scene-info');
  document.getElementById('info-name').textContent = `${scene.name} (${data.nodes.length} 个节点)`;
  document.getElementById('info-desc').textContent = data.description || scene.description || '';

  const rows = document.getElementById('info-nodes');
  rows.innerHTML = '';
  (data.nodes || []).forEach((node, i) => {
    const color = NODE_COLORS[node.type] || NODE_COLORS.default;
    const row = document.createElement('div');
    row.className = 'node-row';
    row.innerHTML = `
      <span class="node-dot" style="background:${color}"></span>
      <span class="node-name">${node.name}</span>
      <span class="node-type">${node.typeLabel || node.type}</span>
    `;
    rows.appendChild(row);
  });
  panel.classList.remove('hidden');
}

/* ========== POI 搜索 / 坐标定位 ========== */

/** 解析坐标输入，如 "31.24, 121.49" / "121.49 31.24"（自动判断 lat/lng 顺序） */
function parseCoord(str) {
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  const aIsLat = Math.abs(a) <= 90;
  const bIsLat = Math.abs(b) <= 90;
  if (aIsLat && !bIsLat) return { lat: a, lng: b };   // 31, 121 → lat, lng
  if (!aIsLat && bIsLat) return { lat: b, lng: a };   // 121, 31 → lng, lat
  if (aIsLat && bIsLat) return { lat: a, lng: b };    // 都合法，按 lat, lng
  return null;
}

/** 定位到坐标：isGcj=true 表示输入已是高德坐标，否则按 WGS-84 转换 */
function locateCoord(coord, isGcj) {
  let lng, lat;
  if (isGcj) {
    lng = coord.lng; lat = coord.lat;
  } else {
    const p = wgs84ToGcj02(coord.lat, coord.lng);
    lng = p.lng; lat = p.lat;
  }
  map.setZoomAndCenter(Math.max(map.getZoom(), 15), [lng, lat]);
  showCoord({ getLng: () => lng, getLat: () => lat });
}

document.getElementById('poi-btn').onclick = () => {
  const raw = document.getElementById('poi-input').value.trim();
  if (!raw) return;
  const coord = parseCoord(raw);
  if (coord) {
    const isGcj = document.getElementById('coord-sys').value === 'gcj';
    locateCoord(coord, isGcj);
  } else {
    searchPoi(raw);
  }
};
document.getElementById('poi-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('poi-btn').click();
});

// 坐标系下拉：同步 placeholder 提示
document.getElementById('coord-sys').onchange = function () {
  document.getElementById('poi-input').placeholder = this.value === 'gcj'
    ? '搜地点 / 输入坐标(GCJ-02)，如 31.24, 121.49'
    : '搜地点 / 输入坐标(WGS-84)，如 31.24, 121.49';
};

let placeSearch = null;
AMap.plugin(['AMap.PlaceSearch'], () => {
  placeSearch = new AMap.PlaceSearch({
    pageSize: 10,
    pageIndex: 1,
    citylimit: false, // 全国范围搜索
  });
});

function searchPoi(keyword) {
  if (!placeSearch) { alert('搜索组件尚未就绪，请稍后再试'); return; }
  clearPoi();
  placeSearch.search(keyword, (status, result) => {
    if (status !== 'complete' || !result.poiList || !result.poiList.pois.length) {
      alert(`未找到与「${keyword}」相关的地点`);
      return;
    }
    const pois = result.poiList.pois;
    pois.forEach(poi => {
      const pos = [poi.location.lng, poi.location.lat];
      const marker = new AMap.Marker({
        position: pos,
        content: '<div style="width:20px;height:20px;background:#1e88e5;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',
        anchor: 'center',
      });
      marker.on('click', () => {
        const content = `<div style="font-size:13px;line-height:1.6;min-width:180px">
          <b style="font-size:14px">${poi.name}</b><br>
          <span style="color:#888">${poi.type || ''}</span><br>
          ${poi.address || ''}
        </div>`;
        if (!infoWindow) infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -8) });
        infoWindow.setContent(content);
        infoWindow.open(map, pos);
      });
      map.add(marker);
      poiMarkers.push(marker);
    });
    // 视野适配到全部结果（避免 POI 被搜索框/控制条遮挡）
    map.setFitView(poiMarkers, false, [90, 90, 90, 90]);
  });
}

/* ========== 事件绑定 ========== */
document.getElementById('poi-btn').onclick = () => {
  const kw = document.getElementById('poi-input').value.trim();
  if (kw) searchPoi(kw);
};
document.getElementById('poi-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('poi-btn').click();
});

// 点击地图空白处关闭信息窗
map.on('click', () => { if (infoWindow) infoWindow.close(); });

// 图层控制
document.querySelectorAll('.lc-btn[data-mode]').forEach(btn => {
  btn.onclick = () => setBaseMode(btn.dataset.mode);
});
document.getElementById('lc-zoom-in').onclick = () => map.zoomIn();
document.getElementById('lc-zoom-out').onclick = () => map.zoomOut();

/* ========== 获取坐标（双击 / 移动端长按） ========== */
let coordMarker = null;

/** 在指定高德坐标处显示坐标面板（gcjLngLat 为 AMap.LngLat） */
function showCoord(gcjLngLat) {
  const gcj = { lng: gcjLngLat.getLng(), lat: gcjLngLat.getLat() };
  const wgs = gcj02ToWgs84(gcj.lat, gcj.lng);

  // 临时标记双击位置
  if (coordMarker) map.remove(coordMarker);
  coordMarker = new AMap.Marker({
    position: [gcj.lng, gcj.lat],
    content: '<div style="width:16px;height:16px;background:#10b981;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',
    anchor: 'center',
  });
  map.add(coordMarker);

  // 更新坐标面板
  document.getElementById('coord-gcj').textContent = `${gcj.lng.toFixed(6)}, ${gcj.lat.toFixed(6)}`;
  document.getElementById('coord-wgs').textContent = `${wgs.lng.toFixed(6)}, ${wgs.lat.toFixed(6)}`;
  document.getElementById('coord-panel').classList.remove('hidden');
}

// 桌面：双击取坐标
map.on('dblclick', e => showCoord(e.lnglat));

// 移动端：长按取坐标（500ms 无移动触发），touchend/移动取消
const mapContainer = document.getElementById('map');
let longPressTimer = null;
mapContainer.addEventListener('touchstart', e => {
  if (e.touches && e.touches.length === 1) {
    const t = e.touches[0];
    longPressTimer = setTimeout(() => {
      const rect = mapContainer.getBoundingClientRect();
      const lnglat = map.containerToLngLat(new AMap.Pixel(t.clientX - rect.left, t.clientY - rect.top));
      showCoord(lnglat);
    }, 500);
  }
}, { passive: true });
['touchmove', 'touchend', 'touchcancel'].forEach(evt => {
  mapContainer.addEventListener(evt, () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { passive: true });
});

function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = '✅ 已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
  done();
}

document.getElementById('coord-close').onclick = () => {
  document.getElementById('coord-panel').classList.add('hidden');
  if (coordMarker) { map.remove(coordMarker); coordMarker = null; }
};
document.getElementById('coord-copy-gcj').onclick = function () {
  copyText(document.getElementById('coord-gcj').textContent, this);
};
document.getElementById('coord-copy-wgs').onclick = function () {
  copyText(document.getElementById('coord-wgs').textContent, this);
};

/* ========== 定位我的位置 ========== */
let geolocation = null;
let geoMarker = null;
let geoCircle = null;

AMap.plugin(['AMap.Geolocation'], () => {
  geolocation = new AMap.Geolocation({
    enableHighAccuracy: true, // 高精度
    timeout: 10000,           // 10s 超时
    maximumAge: 0,            // 每次重新获取
  });
});

function clearGeoMarker() {
  if (geoMarker) { map.remove(geoMarker); geoMarker = null; }
  if (geoCircle) { map.remove(geoCircle); geoCircle = null; }
}

document.getElementById('lc-locate').onclick = () => {
  if (!geolocation) { alert('定位组件尚未就绪，请稍后再试'); return; }
  geolocation.getCurrentPosition((status, result) => {
    if (status !== 'complete' || !result.position) {
      alert('定位失败：' + (result && result.message ? result.message : '请检查浏览器定位权限'));
      return;
    }

    clearGeoMarker();
    const pos = [result.position.getLng(), result.position.getLat()];
    const wgs = gcj02ToWgs84(pos[1], pos[0]);

    // 定位点（蓝点 + 白色描边，类似高德 app）
    geoMarker = new AMap.Marker({
      position: pos,
      content: '<div style="width:18px;height:18px;background:#1e88e5;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 2px #1e88e5, 0 2px 8px rgba(0,0,0,.4)"></div>',
      anchor: 'center',
      zIndex: 120,
    });
    map.add(geoMarker);

    // 精度圈（浏览器定位的误差范围）
    if (result.accuracy && result.accuracy > 0) {
      geoCircle = new AMap.Circle({
        center: pos,
        radius: result.accuracy,
        strokeColor: '#1e88e5',
        strokeOpacity: 0.5,
        strokeWeight: 1,
        fillColor: '#1e88e5',
        fillOpacity: 0.1,
      });
      map.add(geoCircle);
    }

    // 居中并保证足够级别
    map.setZoomAndCenter(Math.max(map.getZoom(), 15), pos);

    // 信息窗：定位方式 + 精度 + 两种坐标
    const info = `<div style="font-size:13px;line-height:1.7;min-width:200px">
      <b>📍 我的位置</b><br>
      <span style="color:#888">方式：${result.locationType || '浏览器'} · 精度约 ${Math.round(result.accuracy || 0)}m</span><br>
      <span style="color:#888">GCJ-02：</span>${pos[0].toFixed(6)}, ${pos[1].toFixed(6)}<br>
      <span style="color:#888">WGS-84：</span>${wgs.lng.toFixed(6)}, ${wgs.lat.toFixed(6)}
    </div>`;
    if (!infoWindow) infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -8) });
    infoWindow.setContent(info);
    infoWindow.open(map, pos);
  });
};

/* ========== 侧边栏收起/展开 ========== */
const sidebarToggle = document.getElementById('sidebar-toggle');
sidebarToggle.onclick = () => {
  document.body.classList.toggle('sidebar-collapsed');
  sidebarToggle.textContent = document.body.classList.contains('sidebar-collapsed') ? '»' : '«';
  map.resize(); // 通知高德地图容器尺寸变化
};
// 初始状态同步按钮符号（移动端默认已收起）
sidebarToggle.textContent = document.body.classList.contains('sidebar-collapsed') ? '»' : '«';

/* ========== 场景信息面板 ========== */
document.getElementById('info-close').onclick = () => {
  document.getElementById('scene-info').classList.add('hidden');
};

/* ========== 启动 ========== */
loadScenes();
