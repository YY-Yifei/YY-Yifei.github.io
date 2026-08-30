/**
 * 上海市公交线网 BusMap
 * 数据：data/stops.json（站点坐标 WGS-84）+ data/routes.json（线路站点序列）
 * 底图：高德 JS API 2.0（显示坐标 GCJ-02，内部转换）
 */
(function () {
  'use strict';

  /* ========== 坐标系转换 WGS-84 → GCJ-02 ========== */
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
  function toAMap(lat, lng) {
    if (outOfChina(lat, lng)) return [lng, lat];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * PI;
    let magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }

  /* ========== 状态 ========== */
  const state = {
    routes: [],          // [{n, up[], down[], upCount, downCount}]
    stops: [],           // [{n, lat, lng, gLat, gLng, rc}] g* 为 GCJ-02 缓存
    stopIndex: new Map(),// 站名 -> [stops]
    map: null,
    massMarks: null,     // 全站点海量标记
    currentRoute: null,
    currentPolylines: [],
    currentMarkers: [],
    currentInfoWindow: null,
    searchTerm: '',
    stopRoutes: null,    // 站名 -> 途经线路列表（懒加载）
    currentMode: 'all',  // 'near' 周边5km | 'all' 全上海
    currentCenter: null, // GCJ-02 [lng, lat]
    radiusKm: 5,
  };

  const $ = (id) => document.getElementById(id);

  /* ========== 初始化地图 ========== */
  if (typeof AMap === 'undefined') {
    $('route-list').innerHTML = '<p class="loading">⚠️ 高德地图 SDK 加载失败</p>';
    return;
  }
  state.map = new AMap.Map('map', {
    zoom: 10,
    center: [121.47, 31.23],
    viewMode: '2D',
    mapStyle: 'amap://styles/normal',
  });

  /* ========== 加载数据 ========== */
  async function loadData() {
    try {
      const [stopsRes, routesRes] = await Promise.all([
        fetch('data/stops.json'),
        fetch('data/routes.json'),
      ]);
      if (!stopsRes.ok || !routesRes.ok) throw new Error('HTTP ' + stopsRes.status + '/' + routesRes.status);
      const stopsData = await stopsRes.json();
      const routesData = await routesRes.json();

      state.stops = stopsData.stops || [];
      state.routes = routesData.routes || [];
      const uniqueStopCount = stopsData.count || new Set(state.stops.map((s) => s.n)).size;

      // 预计算 GCJ-02 坐标（供筛选/渲染复用）
      for (const s of state.stops) {
        const g = toAMap(s.lat, s.lng);
        s.gLng = g[0];
        s.gLat = g[1];
      }

      // 建索引（同名站多坐标）
      state.stopIndex.clear();
      for (const s of state.stops) {
        if (!state.stopIndex.has(s.n)) state.stopIndex.set(s.n, []);
        state.stopIndex.get(s.n).push(s);
      }

      $('stat-stops').textContent = '站点 ' + uniqueStopCount;
      $('stat-routes').textContent = '线路 ' + state.routes.length;

      renderRouteList(state.routes);
      initMassMarks();

      // 默认定位到当前位置，渲染周边 5km；失败则全量
      locateAndRender(5).then((ok) => {
        if (!ok) {
          state.currentMode = 'all';
          renderStops(null);
          fitShanghai();
        }
      });
    } catch (e) {
      $('route-list').innerHTML = '<p class="empty">⚠️ 数据加载失败：' + e.message + '</p>';
    }
  }

  /* ========== 海量站点标记 ========== */
  const MARK_STYLE = {
    url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3" fill="rgba(10,125,52,0.55)"/></svg>'),
    size: new AMap.Size(8, 8),
    offset: new AMap.Pixel(-4, -4),
  };

  function initMassMarks() {
    state.massMarks = new AMap.MassMarks([], {
      opacity: 0.8,
      zIndex: 5,
      cursor: 'pointer',
      style: MARK_STYLE,
    });
    state.massMarks.on('click', (e) => {
      const data = e.data;
      const ll = data && data.lnglat;
      if (!ll) return;
      const pos = Array.isArray(ll) ? [ll[0], ll[1]] : [ll.getLng(), ll.getLat()];
      if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;
      showStopInfo(pos, data.name, data.rc);
    });
    state.massMarks.setMap(state.map);
  }

  /** 渲染站点：center=null 渲染全部；否则渲染 center 周围 radiusKm 内 */
  function renderStops(center) {
    if (!state.massMarks) return;
    let points;
    if (center) {
      const [clng, clat] = center;
      points = [];
      for (const s of state.stops) {
        if (!Number.isFinite(s.gLng) || !Number.isFinite(s.gLat)) continue;
        const d = haversineKm(clng, clat, s.gLng, s.gLat);
        if (d <= state.radiusKm) {
          points.push({ lnglat: new AMap.LngLat(s.gLng, s.gLat), name: s.n, rc: s.rc || 0 });
        }
      }
      $('stat-stops').textContent = '周边站点 ' + points.length;
    } else {
      points = [];
      for (const s of state.stops) {
        if (Number.isFinite(s.gLng) && Number.isFinite(s.gLat)) {
          points.push({ lnglat: new AMap.LngLat(s.gLng, s.gLat), name: s.n, rc: s.rc || 0 });
        }
      }
      $('stat-stops').textContent = '站点 ' + (state.stopIndex.size || points.length);
    }
    state.massMarks.setData(points);
  }

  /** 定位到当前位置并渲染周边站点；失败返回 false */
  function locateAndRender(radiusKm) {
    state.radiusKm = radiusKm || 5;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      const onPos = (lnglatGcj) => {
        if (!lnglatGcj || !Number.isFinite(lnglatGcj[0]) || !Number.isFinite(lnglatGcj[1])) {
          finish(false);
          return;
        }
        state.currentCenter = [lnglatGcj[0], lnglatGcj[1]];
        state.currentMode = 'near';
        renderStops(state.currentCenter);
        state.map.setZoomAndCenter(13, new AMap.LngLat(state.currentCenter[0], state.currentCenter[1]));
        showToast('📍 已定位，显示周边 ' + state.radiusKm + 'km 站点');
        finish(true);
      };

      // 优先高德定位
      if (typeof AMap.Geolocation !== 'undefined') {
        const geolocation = new AMap.Geolocation({
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 30000,
        });
        geolocation.getCurrentPosition((status, result) => {
          if (status === 'complete' && result && result.position) {
            onPos([result.position.getLng(), result.position.getLat()]);
          } else {
            fallbackLocate(onPos, finish);
          }
        });
      } else {
        fallbackLocate(onPos, finish);
      }
    });
  }

  /** 回退：HTML5 geolocation（返回 WGS-84，转 GCJ） */
  function fallbackLocate(onPos, finish) {
    if (!('geolocation' in navigator)) {
      showToast('无法定位，已显示全上海站点');
      finish(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const wgs = [pos.coords.longitude, pos.coords.latitude];
        const g = toAMap(wgs[1], wgs[0]);
        onPos([g[0], g[1]]);
      },
      () => {
        showToast('定位被拒绝，已显示全上海站点');
        finish(false);
      },
      { timeout: 8000, maximumAge: 30000 }
    );
  }

  /* ========== 站点信息窗体 ========== */
  function showStopInfo(lnglat, name, rc, label) {
    if (!lnglat || !Number.isFinite(lnglat[0]) || !Number.isFinite(lnglat[1])) return;
    const content = document.createElement('div');
    content.innerHTML =
      '<div class="sname">🚏 ' + escapeHtml(name) + (label ? '<span class="slabel">' + escapeHtml(label) + '</span>' : '') + '</div>' +
      '<div class="smeta">途经线路加载中…</div>';
    if (!state.currentInfoWindow) {
      state.currentInfoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -8) });
    }
    state.currentInfoWindow.setContent(content);
    state.currentInfoWindow.open(state.map, new AMap.LngLat(lnglat[0], lnglat[1]));

    // 异步加载线路列表并渲染
    loadStopRoutes(name).then((list) => {
      if (!state.currentInfoWindow || !state.currentInfoWindow.getContent()) return;
      renderStopRoutes(content, name, label, list, rc);
    });
  }

  /** 懒加载 stop_routes.json 并缓存 */
  async function loadStopRoutes(name) {
    if (!state.stopRoutes) {
      try {
        const res = await fetch('data/stop_routes.json');
        state.stopRoutes = (await res.json()).stopRoutes || {};
      } catch (e) {
        state.stopRoutes = {};
      }
    }
    return state.stopRoutes[name] || [];
  }

  /** 渲染站点弹窗的线路列表 */
  function renderStopRoutes(container, name, label, list, rc) {
    container.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'sname';
    title.innerHTML = '🚏 ' + escapeHtml(name) +
      (label ? '<span class="slabel">' + escapeHtml(label) + '</span>' : '');
    container.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'smeta';
    meta.textContent = '途经 ' + (list.length || rc || 0) + ' 条线路';
    container.appendChild(meta);

    if (list.length) {
      const wrap = document.createElement('div');
      wrap.className = 'route-chips';
      for (const rn of list) {
        const chip = document.createElement('span');
        chip.className = 'route-chip';
        chip.textContent = rn;
        chip.title = '查看 ' + rn + ' 线路走向';
        chip.addEventListener('click', () => {
          if (state.currentInfoWindow) state.currentInfoWindow.close();
          const route = state.routes.find((r) => r.n === rn);
          if (route) {
            selectRoute(route);
          } else {
            showToast('⚠️ 未找到线路 ' + rn);
          }
        });
        wrap.appendChild(chip);
      }
      container.appendChild(wrap);
    } else {
      const empty = document.createElement('div');
      empty.className = 'smeta';
      empty.textContent = rc && rc > 0 ? '（线路明细未收录）' : '（暂无线路信息）';
      container.appendChild(empty);
    }
  }

  /* ========== 线路列表 ========== */
  function renderRouteList(routes) {
    const box = $('route-list');
    if (!routes.length) {
      box.innerHTML = '<p class="empty">没有匹配的线路</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of routes) {
      const item = document.createElement('div');
      item.className = 'route-item' + (state.currentRoute && state.currentRoute.n === r.n ? ' active' : '');
      const total = (r.upCount || 0) + (r.downCount || 0);
      item.innerHTML =
        '<span class="route-no">' + escapeHtml(r.n) + '</span>' +
        '<span class="route-meta">' +
        '  <div class="route-name">' + escapeHtml(r.n) + '</div>' +
        '  <div class="route-tag">' + total + ' 站 · ' +
          ((r.upCount ? '上行' + r.upCount : '') + (r.upCount && r.downCount ? ' / ' : '') + (r.downCount ? '下行' + r.downCount : '')) +
        '</div>' +
        '</span>';
      item.addEventListener('click', () => selectRoute(r));
      frag.appendChild(item);
    }
    box.innerHTML = '';
    box.appendChild(frag);
  }

  function applySearch() {
    const term = state.searchTerm.trim();
    let list = state.routes;
    if (term) {
      list = state.routes.filter((r) => r.n.indexOf(term) !== -1);
    }
    renderRouteList(list);
  }

  /* ========== 选中线路 ========== */
  function selectRoute(route) {
    state.currentRoute = route;
    clearRouteLayers();
    // 高亮列表
    document.querySelectorAll('.route-item').forEach((el) => el.classList.remove('active'));
    const items = document.querySelectorAll('.route-item');
    items.forEach((el) => {
      const no = el.querySelector('.route-no');
      if (no && no.textContent === route.n) el.classList.add('active');
    });

    // 画上行/下行
    const colors = { up: '#0a7d34', down: '#ea580c' };
    if (route.up && route.up.length) drawDirection(route.up, '上行', colors.up);
    if (route.down && route.down.length) drawDirection(route.down, '下行', colors.down);

    renderDetail(route);
    fitRoute(route);
    showToast('已显示 ' + route.n);
  }

  function drawDirection(stops, dirLabel, color) {
    // stops: [{n, lat, lng}]；无坐标或与上一坐标距离 >15km 时断开
    const segments = [];
    let cur = [];
    let prevLatLng = null;
    for (const s of stops) {
      const has = s && typeof s.lat === 'number';
      let tooFar = false;
      if (has && prevLatLng) {
        tooFar = haversineKm(prevLatLng[0], prevLatLng[1], s.lng, s.lat) > 15;
      }
      if (!has || tooFar) {
        if (cur.length >= 2) segments.push(cur);
        cur = [];
        prevLatLng = null;
      } else {
        cur.push({ name: s.n, lnglat: toAMap(s.lat, s.lng) });
        prevLatLng = [s.lng, s.lat];
      }
    }
    if (cur.length >= 2) segments.push(cur);

    // polyline
    for (const seg of segments) {
      const path = seg.map((p) => p.lnglat);
      const line = new AMap.Polyline({
        path,
        strokeColor: color,
        strokeWeight: 4,
        strokeOpacity: 0.85,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 20,
      });
      line.setMap(state.map);
      state.currentPolylines.push(line);
    }

    // 站点 marker
    stops.forEach((s, i) => {
      if (!s || typeof s.lat !== 'number' || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
      const pos = toAMap(s.lat, s.lng);
      if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;
      const marker = new AMap.Marker({
        position: pos,
        content: makeStopDot(i + 1, color, s.n),
        offset: new AMap.Pixel(-9, -9),
        zIndex: 30,
        title: s.n,
      });
      marker.on('click', () => {
        showStopInfo(pos, s.n, stopRouteCount(s.n), dirLabel + ' 第' + (i + 1) + '站');
      });
      marker.setMap(state.map);
      state.currentMarkers.push(marker);
    });
  }

  function stopRouteCount(name) {
    const list = state.stopIndex.get(name);
    if (!list || !list.length) return 0;
    return list[0].rc || 0;
  }

  function haversineKm(lng1, lat1, lng2, lat2) {
    const R = 6371.0;
    const rad = (d) => (d * PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function makeStopDot(seq, color, name) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18">' +
      '<circle cx="9" cy="9" r="8" fill="' + color + '" stroke="#fff" stroke-width="2"/>' +
      '<text x="9" y="13" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">' + seq + '</text>' +
      '</svg>';
    return svg;
  }

  function pickStop(name) {
    const list = state.stopIndex.get(name);
    if (!list || !list.length) return null;
    // 优先取第一个（坐标构建时已按线路数排序）
    return list[0];
  }

  /* ========== 详情面板 ========== */
  function renderDetail(route) {
    $('detail-name').textContent = route.n;
    const stats = [];
    if (route.upCount) stats.push('上行 ' + route.upCount + ' 站');
    if (route.downCount) stats.push('下行 ' + route.downCount + ' 站');
    stats.push('共 ' + ((route.upCount || 0) + (route.downCount || 0)) + ' 个站次');
    $('detail-stats').textContent = stats.join(' · ');

    const box = $('detail-stops');
    box.innerHTML = '';
    const dirs = [];
    if (route.up && route.up.length) dirs.push({ label: '上行', list: route.up });
    if (route.down && route.down.length) dirs.push({ label: '下行', list: route.down });

    for (const d of dirs) {
      const h = document.createElement('div');
      h.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-2);padding:10px 8px 4px;';
      h.textContent = '⬆ ' + d.label + '（' + d.list.length + ' 站）';
      box.appendChild(h);
      d.list.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'stop-row';
        const has = s && typeof s.lat === 'number';
        row.innerHTML =
          '<span class="seq">' + (i + 1) + '</span>' +
          '<span class="stop-name">' + escapeHtml(s.n) + '</span>' +
          '<span class="direction">' + (has ? '' : '⚠ 无坐标') + '</span>';
        if (has) {
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
            const lnglat = toAMap(s.lat, s.lng);
            if (!Number.isFinite(lnglat[0]) || !Number.isFinite(lnglat[1])) return;
            state.map.setZoomAndCenter(16, new AMap.LngLat(lnglat[0], lnglat[1]));
            showStopInfo(lnglat, s.n, stopRouteCount(s.n));
          });
        } else {
          row.style.opacity = '.55';
        }
        box.appendChild(row);
      });
    }
    $('route-detail').classList.remove('hidden');
  }

  function clearRouteLayers() {
    state.currentPolylines.forEach((l) => l.setMap(null));
    state.currentPolylines = [];
    state.currentMarkers.forEach((m) => m.setMap(null));
    state.currentMarkers = [];
    if (state.currentInfoWindow) state.currentInfoWindow.close();
  }

  /* ========== 视野 ========== */
  function fitShanghai() {
    state.map.setZoomAndCenter(10, new AMap.LngLat(121.47, 31.23));
  }

  function fitRoute(route) {
    const pts = [];
    const lists = [];
    if (route.up) lists.push(route.up);
    if (route.down) lists.push(route.down);
    for (const list of lists) {
      for (const s of list) {
        if (s && typeof s.lat === 'number' && Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
          pts.push(toAMap(s.lat, s.lng));
        }
      }
    }
    if (pts.length >= 2) {
      // Bounds 必须用 LngLat 实例构造（传数组会得到 LngLat(NaN, NaN)）
      let minLng = pts[0][0], minLat = pts[0][1], maxLng = pts[0][0], maxLat = pts[0][1];
      for (const p of pts) {
        if (p[0] < minLng) minLng = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[0] > maxLng) maxLng = p[0];
        if (p[1] > maxLat) maxLat = p[1];
      }
      const bounds = new AMap.Bounds(
        new AMap.LngLat(minLng, minLat),
        new AMap.LngLat(maxLng, maxLat)
      );
      state.map.setBounds(bounds, false, { top: 40, right: 40, bottom: 40, left: 40 });
    }
  }

  /* ========== 工具 ========== */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let toastTimer = null;
  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  /* ========== 事件 ========== */
  $('sidebar-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-collapsed');
    setTimeout(() => state.map && state.map.resize(), 320);
  });
  $('route-input').addEventListener('input', (e) => {
    state.searchTerm = e.target.value;
    applySearch();
  });
  $('detail-close').addEventListener('click', () => {
    $('route-detail').classList.add('hidden');
    clearRouteLayers();
    state.currentRoute = null;
    document.querySelectorAll('.route-item').forEach((el) => el.classList.remove('active'));
  });

  // 视图控制
  $('vc-locate').addEventListener('click', () => {
    locateAndRender(5);
  });
  $('vc-all').addEventListener('click', () => {
    state.currentMode = 'all';
    renderStops(null);
    fitShanghai();
    showToast('🌐 已显示全上海站点');
  });
  $('vc-zoom-in').addEventListener('click', () => {
    state.map.zoomIn();
  });
  $('vc-zoom-out').addEventListener('click', () => {
    state.map.zoomOut();
  });

  /* ========== 启动 ========== */
  loadData();
})();
