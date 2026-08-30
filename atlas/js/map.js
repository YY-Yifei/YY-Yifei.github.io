/**
 * Atlas 地图标记系统
 * 数据驱动：场景索引 data/scenes.json + 每个场景独立 JSON
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

/* ========== 瓦片源配置 ========== */
const TILE_SOURCES = {
  gaode: {
    name: '高德地图',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234',
    attribution: '&copy; 高德地图',
    gcj: true,
    maxZoom: 18,
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    gcj: false,
    maxZoom: 19,
  },
  carto: {
    name: 'CartoDB',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    gcj: false,
    maxZoom: 19,
  },
};

/* ========== 状态 ========== */
const NODE_COLORS = {
  terminal: '#e74c3c',   // 终点/起点
  station:  '#3498db',   // 普通站点
  hub:      '#f39c12',   // 枢纽
  landmark: '#9b59b6',   // 地标
  border:   '#2ecc71',   // 口岸/边界
  default:  '#64748b',
};

let currentTileSource = 'gaode';
let currentGcj = TILE_SOURCES[currentTileSource].gcj;

const map = L.map('map').setView([24, 103], 5);
const baseLayer = L.tileLayer(TILE_SOURCES.gaode.url, {
  maxZoom: TILE_SOURCES.gaode.maxZoom,
  subdomains: TILE_SOURCES.gaode.subdomains,
  attribution: TILE_SOURCES.gaode.attribution,
}).addTo(map);

// 图层切换控件（右上角）
const baseMaps = {};
Object.keys(TILE_SOURCES).forEach(key => {
  const src = TILE_SOURCES[key];
  baseMaps[src.name] = L.tileLayer(src.url, {
    maxZoom: src.maxZoom,
    subdomains: src.subdomains,
    attribution: src.attribution,
  });
});
L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

map.on('baselayerchange', (e) => {
  const name = e.name;
  const key = Object.keys(TILE_SOURCES).find(k => TILE_SOURCES[k].name === name);
  if (key) {
    currentTileSource = key;
    currentGcj = TILE_SOURCES[key].gcj;
    if (currentScene) selectScene(currentScene); // 重绘以应用坐标系
  }
});

/** WGS-84 坐标 → 当前瓦片源坐标系 */
function toDisplay(lat, lng) {
  if (!currentGcj) return [lat, lng];
  const p = wgs84ToGcj02(lat, lng);
  return [p.lat, p.lng];
}

/* ========== 场景管理 ========== */
let scenes = [];
let currentScene = null;
let currentLayers = [];

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

  // 设置默认视角
  if (data.view) {
    map.setView(toDisplay(data.view.center[0], data.view.center[1]), data.view.zoom);
  }

  // 画连线（先画线，节点盖在上面）
  (data.lines || []).forEach(line => drawLine(line, data.nodes));

  // 画节点
  (data.nodes || []).forEach(node => drawNode(node, scene));

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

/** 清空当前图层 */
function clearLayers() {
  currentLayers.forEach(l => map.removeLayer(l));
  currentLayers = [];
}

/** 画节点标记 */
function drawNode(node, scene) {
  const color = NODE_COLORS[node.type] || NODE_COLORS.default;
  const [lat, lng] = toDisplay(node.lat, node.lng);
  const icon = L.divIcon({
    className: 'custom-marker',
    html: `<div style="width:26px;height:26px;background:${color};border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:bold;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${node.label || node.name.charAt(0)}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

  const marker = L.marker([lat, lng], { icon })
    .addTo(map)
    .bindPopup(`<b>${node.name}</b><br><span style="color:#64748b">${node.typeLabel || node.type}</span><br>${node.description || ''}`);

  currentLayers.push(marker);
}

/** 画连线 */
function drawLine(line, nodes) {
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  const points = (line.path || [])
    .map(id => nodeMap[id])
    .filter(n => n)
    .map(n => toDisplay(n.lat, n.lng));

  if (points.length < 2) return;

  const polyline = L.polyline(points, {
    color: line.color || '#e74c3c',
    weight: 4,
    opacity: 0.8,
    dashArray: line.dashed ? '8 8' : null,
  }).addTo(map);

  polyline.bindPopup(`<b>${line.name}</b>`);
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
      <span class="node-name">${i + 1}. ${node.name}</span>
      <span class="node-type">${node.typeLabel || node.type}</span>
      <span class="node-desc">${node.description || ''}</span>
    `;
    rows.appendChild(row);
  });

  panel.classList.remove('hidden');
}

document.getElementById('info-close').onclick = () => {
  document.getElementById('scene-info').classList.add('hidden');
};

loadScenes();
