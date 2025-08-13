// ==UserScript==
// @name         Ollama本地流式翻译器
// @namespace    https://tampermonkey.net/
// @version      1.1
// @description  通过本地 Ollama 对网页进行就地翻译；逐段翻译并实时替换，提供面板设置模型/目标语言/并发等参数，类似谷歌翻译的逐段出现效果。
// @author       hex0x13h
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  // ----------- 默认/持久化配置 -----------
  const CFG = {
    apiUrl: GM_getValue('apiUrl', 'http://127.0.0.1:11434/api/generate'), // 建议用 127.0.0.1 更稳
    model: GM_getValue('model', 'zongwei/gemma3-translator:4b'),
    targetLang: GM_getValue('targetLang', 'Chinese (Simplified)'),
    maxChunk: GM_getValue('maxChunk', 600),     // 每段最大字符数（太大影响速度）
    minLen: GM_getValue('minLen', 6),           // 短文本不翻
    concurrency: GM_getValue('concurrency', 2), // 同时翻译多少段
    temperature: GM_getValue('temperature', 0),
  };

  // ----------- 样式/UI -----------
  GM_addStyle(`
  #oltx-panel{position:fixed;left:20px;top:20px;z-index:2147483647;width:380px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial}
  #oltx-head{cursor:move;padding:10px 12px;border-bottom:1px solid #eee;background:#111;color:#fff;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center}
  #oltx-title{font-weight:600}
  #oltx-body{padding:10px 12px}
  .oltx-row{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;margin:6px 0}
  .oltx-row input{width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:8px}
  .oltx-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
  .oltx-actions button{flex:1 1 auto;padding:8px;border-radius:10px;border:1px solid #ddd;background:#f7f7f7;cursor:pointer}
  .oltx-actions button.primary{background:#0f172a;color:#fff;border-color:#0f172a}
  #oltx-bar{height:6px;background:#eee;border-radius:6px;overflow:hidden;margin-top:6px}
  #oltx-bar>div{height:100%;width:0;background:#16a34a;transition:width .2s}
  #oltx-stat{color:#444;margin-top:6px}
  #oltx-tip{color:#666;font-size:12px;margin-top:4px}
  .oltx-badge{display:inline-block;background:#eef;border:1px solid #ccd;padding:2px 6px;border-radius:8px;margin-left:6px;color:#334}
  #oltx-panel.minimized #oltx-body{display:none}
  #oltx-panel.minimized{width:auto;min-width:200px}
  /* 新增：我们包裹的 span 的状态标记（可视化） */
  .oltx-span[data-state="translating"]{padding:1px 2px;}
  .oltx-span[data-state="translated"]{padding:1px 2px;}
  .oltx-span[data-state="error"]{padding:1px 2px;}
  `);

  // 工具函数定义（需要在模板字符串之前定义）
  function escapeHtml(s){return (s||'').replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
  function $(q){ return document.querySelector(q); }
  function stat(t){ $('#oltx-stat').textContent = t; }

  const panel = document.createElement('div');
  panel.id = 'oltx-panel';
  panel.innerHTML = `
    <div id="oltx-head">
      <div id="oltx-title">Ollama本地翻译器<span class="oltx-badge">流式</span></div>
      <div>
        <button id="oltx-minimize" style="background:#333;color:#fff;border:none;border-radius:8px;padding:4px 8px;cursor:pointer;margin-right:4px">−</button>
        <button id="oltx-hide" style="background:#333;color:#fff;border:none;border-radius:8px;padding:4px 8px;cursor:pointer">✕</button>
      </div>
    </div>
    <div id="oltx-body">
      <div class="oltx-row"><label>API 地址</label><input id="oltx-api" value="${escapeHtml(CFG.apiUrl)}" placeholder="http://127.0.0.1:11434/api/generate"></div>
      <div class="oltx-row"><label>模型名</label><input id="oltx-model" value="${escapeHtml(CFG.model)}" placeholder="mannix/llama3.1-8b"></div>
      <div class="oltx-row"><label>目标语言</label><input id="oltx-lang" value="${escapeHtml(CFG.targetLang)}" placeholder="Chinese (Simplified) / Arabic / Russian"></div>
      <div class="oltx-row"><label>段最大长度</label><input id="oltx-max" type="number" min="100" max="4000" value="${CFG.maxChunk}"></div>
      <div class="oltx-row"><label>最小长度</label><input id="oltx-min" type="number" min="0" max="200" value="${CFG.minLen}"></div>
      <div class="oltx-row"><label>并发数</label><input id="oltx-conc" type="number" min="1" max="6" value="${CFG.concurrency}"></div>
      <div class="oltx-row"><label>temperature</label><input id="oltx-temp" type="number" min="0" max="1" step="0.1" value="${CFG.temperature}"></div>

      <div class="oltx-actions">
        <button id="oltx-start" class="primary">开始整页翻译</button>
        <button id="oltx-stop">停止</button>
        <button id="oltx-refresh">重新扫描</button>
        <button id="oltx-force-refresh">强制刷新</button>
        <button id="oltx-save">保存设置</button>
        <button id="oltx-debug">调试模式</button>
        <button id="oltx-test">测试API</button>
        <button id="oltx-quick-test">快速测试</button>
      </div>

      <div id="oltx-bar"><div></div></div>
      <div id="oltx-stat">待开始</div>
      <div id="oltx-tip">说明：将逐段替换页面上的可见文本，翻译时会实时出现文字。</div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  dragEnable($('#oltx-head'), panel);
  $('#oltx-minimize').onclick = () => {
    panel.classList.toggle('minimized');
    const btn = $('#oltx-minimize');
    btn.textContent = panel.classList.contains('minimized') ? '□' : '−';
  };
  $('#oltx-hide').onclick = () => panel.remove();
  $('#oltx-save').onclick = saveCfg;
  $('#oltx-start').onclick = startTranslate;
  $('#oltx-stop').onclick = stopAll;
  $('#oltx-refresh').onclick = refreshPage;
  $('#oltx-force-refresh').onclick = forceRefresh;
  $('#oltx-debug').onclick = toggleDebug;
  $('#oltx-test').onclick = testAPI;
  $('#oltx-quick-test').onclick = quickTest;

  // 添加强制重新加载脚本按钮
  const reloadBtn = document.createElement('button');
  reloadBtn.textContent = '重新加载脚本';
  reloadBtn.style.cssText = 'margin-left: 8px; padding: 8px; border-radius: 10px; border: 1px solid #ddd; background: #f7f7f7; cursor: pointer';
  reloadBtn.onclick = () => {
    console.log('重新加载脚本...');
    location.reload();
  };
  document.querySelector('.oltx-actions').appendChild(reloadBtn);

  // 添加一个简单的测试按钮
  const simpleTestBtn = document.createElement('button');
  simpleTestBtn.textContent = '简单测试';
  simpleTestBtn.style.cssText = 'margin-left: 8px; padding: 8px; border-radius: 10px; border: 1px solid #ddd; background: #f7f7f7; cursor: pointer';
  simpleTestBtn.onclick = () => {
    console.log('开始简单测试...');
    console.log('当前配置:', CFG);

    // 使用GM_xmlhttpRequest而不是fetch，避免CORS问题
    GM_xmlhttpRequest({
      method: 'POST',
      url: CFG.apiUrl,
      headers: {'Content-Type': 'application/json'},
      data: JSON.stringify({
        model: CFG.model,
        prompt: 'Translate to Chinese: Hello world',
        stream: false
      }),
      onload: function(response) {
        console.log('原始响应:', response.responseText);
        try {
          const obj = JSON.parse(response.responseText);
          console.log('解析后:', obj);
          if (obj.response) {
            alert(`测试成功！翻译结果: ${obj.response}`);
          } else {
            alert('响应中没有response字段: ' + JSON.stringify(obj));
          }
        } catch(e) {
          console.error('解析失败:', e);
          alert('解析失败: ' + e.message);
        }
      },
      onerror: function(error) {
        console.error('请求失败:', error);
        alert('请求失败: ' + error.error);
      }
    });
  };
  document.querySelector('.oltx-actions').appendChild(simpleTestBtn);

  function saveCfg() {
    CFG.apiUrl = $('#oltx-api').value.trim();
    CFG.model = $('#oltx-model').value.trim();
    CFG.targetLang = $('#oltx-lang').value.trim();
    CFG.maxChunk = parseInt($('#oltx-max').value, 10) || 600;
    CFG.minLen = parseInt($('#oltx-min').value, 10) || 6;
    CFG.concurrency = Math.max(1, Math.min(6, parseInt($('#oltx-conc').value, 10) || 2));
    CFG.temperature = Number($('#oltx-temp').value) || 0;
    GM_setValue('apiUrl', CFG.apiUrl);
    GM_setValue('model', CFG.model);
    GM_setValue('targetLang', CFG.targetLang);
    GM_setValue('maxChunk', CFG.maxChunk);
    GM_setValue('minLen', CFG.minLen);
    GM_setValue('concurrency', CFG.concurrency);
    GM_setValue('temperature', CFG.temperature);
    stat('设置已保存');
  }

  // ----------- DOM 采集：可见文本节点 -----------
  const SKIP_TAG = new Set(['SCRIPT','STYLE','NOSCRIPT','CANVAS','SVG','CODE','PRE','TEXTAREA','INPUT','SELECT','BUTTON']);
  function collectTextNodes(root=document.body){
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node){
        const t = node.nodeValue;
        if (!t) return NodeFilter.FILTER_REJECT;
        if (!t.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || SKIP_TAG.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(p);
        if (style && (style.visibility==='hidden' || style.display==='none')) return NodeFilter.FILTER_REJECT;
        if (t.trim().length < CFG.minLen) return NodeFilter.FILTER_REJECT;

        // 调试：显示找到的文本节点
        if (debugMode) {
          console.log('找到文本节点:', t.trim().substring(0, 50), '长度:', t.trim().length);
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  // ----------- 翻译：队列 + 并发 + 流式更新 -----------
  let controller = { queue:[], inFlight:0, stopped:false, total:0, done:0, reqs:new Set() };
  let debugMode = false;

  function refreshPage(){
    // 清除所有已翻译的span，恢复原文
    document.querySelectorAll('.oltx-span').forEach(span => {
      const original = span.dataset.orig || span.textContent.replace('⏳ ', '');
      const textNode = document.createTextNode(original);
      span.parentNode.replaceChild(textNode, span);
    });
    stat('页面已重置，可以重新开始翻译');
  }

  function forceRefresh(){
    // 强制刷新页面，确保所有翻译结果都正确显示
    location.reload();
  }

  function startTranslate(){
    saveCfg(); // 以当前面板值为准
    controller.stopped = false;
    controller.queue = collectTextNodes();
    controller.total = controller.queue.length;
    controller.done = 0;
    controller.inFlight = 0;
    controller.reqs.forEach(r=>r.abort?.());
    controller.reqs.clear();

    if (controller.total === 0){
      stat('没有可翻译的文本');
      if (debugMode) {
        console.log('页面结构检查:');
        console.log('- body children:', document.body.children.length);
        console.log('- 所有文本节点:', document.evaluate('//text()', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength);
      }
      return;
    }
    stat(`准备就绪：${controller.total} 段`);
    if (debugMode) {
      console.log('找到的文本节点数量:', controller.total);
      controller.queue.slice(0, 5).forEach((node, i) => {
        console.log(`节点${i}:`, node.nodeValue.trim().substring(0, 100));
      });
    }
    pump();
  }

  function pump(){
    while(!controller.stopped && controller.inFlight < CFG.concurrency && controller.queue.length){
      const node = controller.queue.shift();
      translateNode(node);
      controller.inFlight++;
    }
  }

  // ====== 关键修复：不再直接改 TextNode，包裹为 span 后只更新 span.textContent ======
  function translateNode(textNode){
    const original = textNode.nodeValue || '';
    const text = original.trim().slice(0, CFG.maxChunk);

    // 检查是否已经是目标语言（简单检测）
    const isTargetLang = CFG.targetLang.toLowerCase().includes('chinese') &&
                        /[\u4e00-\u9fff]/.test(text);
    if (isTargetLang) {
      // 如果已经是中文，跳过翻译
      if (debugMode) console.log('跳过已翻译文本:', text);
      controller.done++;
      controller.inFlight--;
      progress();
      pump();
      return;
    }

    // 调试：显示正在处理的文本
    if (debugMode) {
      console.log('准备翻译文本:', text, '长度:', text.length);
    }

    // 1) 包裹：<span class="oltx-span" data-orig="...">⏳ 原文</span>
    const span = document.createElement('span');
    span.className = 'oltx-span';
    span.dataset.orig = original;
    span.dataset.state = 'translating';
    span.textContent = '⏳ ' + original;
    // 添加翻译中的视觉样式
    span.style.color = '#ff6600'; // 橙色文字

    // 有些站点父节点可能瞬间被重渲染，先拿 parent 再替换即可
    const parent = textNode.parentNode;
    if (!parent) return; // 保险
    parent.replaceChild(span, textNode);

    const prompt = `Translate to ${CFG.targetLang}: "${text}"`;

    const req = streamGenerate({
      url: CFG.apiUrl,
      body: {
        model: CFG.model,
        prompt,
        stream: true,
        options: { temperature: Number(CFG.temperature) || 0 }
      },
      onChunk: (delta, total) => {
        // 2) 只更新我们自己的 span，不碰外层框架的 TextNode
        if (span.isConnected && total && total.trim()) {
          const cleanText = total.trim();
          span.textContent = cleanText;
          // 保持翻译中的样式
          span.style.color = '#ff6600';
          if (debugMode) {
            console.log('翻译中:', original, '->', cleanText, 'delta:', delta);
          }
        }
      },
      onDone: (finalText) => {
        if (span.isConnected) {
          // 确保翻译结果不为空且有效
          const translatedText = finalText && finalText.trim() ? finalText.trim() : original;
          span.textContent = translatedText;
          span.dataset.state = 'translated';
          // 恢复默认颜色
          span.style.color = '';
          span.style.fontWeight = 'bold';

          if (debugMode) {
            console.log('翻译完成:', original, '->', translatedText, 'finalText:', finalText);
          }
        }
        next();
      },
      onError: (msg) => {
        if (span.isConnected) {
          // 回退原文，保持页面不破碎
          span.textContent = original;
          span.dataset.state = 'error';
          // 错误时不设置背景色
        }
        console.warn('翻译失败：', msg, '原文:', original);
        next();
      }
    });

    controller.reqs.add(req);

    function next(){
      controller.reqs.delete(req);
      controller.done++;
      controller.inFlight--;
      progress();
      pump();
    }
  }
  // ====== 关键修复结束 ======

  function progress(){
    const p = controller.total ? Math.round(controller.done/controller.total*100) : 100;
    $('#oltx-bar>div').style.width = p + '%';
    stat(`已完成 ${controller.done}/${controller.total}（${p}%） 并发：${controller.inFlight}/${CFG.concurrency}`);
    if (controller.done === controller.total) stat('全部完成');
  }

  function stopAll(){
    controller.stopped = true;
    controller.reqs.forEach(r=>r.abort?.());
    controller.reqs.clear();
    controller.inFlight = 0;
    stat('已停止');
  }

  function toggleDebug(){
    debugMode = !debugMode;
    $('#oltx-debug').textContent = debugMode ? '关闭调试' : '调试模式';
    $('#oltx-debug').style.background = debugMode ? '#ff6b6b' : '#f7f7f7';
    stat(debugMode ? '调试模式已开启' : '调试模式已关闭');
  }

  function testAPI(){
    saveCfg();
    stat('测试API连接中...');

    const testReq = streamGenerate({
      url: CFG.apiUrl,
      body: {
        model: CFG.model,
        prompt: 'Translate "Hello world" to Chinese',
        stream: true,
        options: { temperature: 0 }
      },
      onChunk: (delta, total) => {
        if (debugMode) console.log('测试响应:', total);
      },
      onDone: (finalText) => {
        stat(`API测试成功: ${finalText}`);
        console.log('API测试完成:', finalText);

        // 检查测试结果是否为空
        if (!finalText || finalText.trim() === '') {
          console.error('API测试结果为空');
          stat('API测试结果为空，请检查模型配置');

          const testDiv = document.createElement('div');
          testDiv.style.cssText = `
            position: fixed;
            top: 50px;
            right: 50px;
            background: #f44336;
            color: white;
            padding: 20px;
            border-radius: 10px;
            z-index: 10000;
            font-size: 16px;
            max-width: 400px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
          `;
          testDiv.innerHTML = `
            <h3>API测试失败</h3>
            <p><strong>错误:</strong> 响应结果为空</p>
            <p><strong>模型:</strong> ${CFG.model}</p>
            <p><strong>建议:</strong></p>
            <ul style="text-align:left;margin:10px 0;">
              <li>尝试使用其他模型</li>
              <li>检查模型是否支持文本生成</li>
              <li>尝试不同的提示语</li>
            </ul>
            <button onclick="this.parentElement.remove()" style="background:#fff;color:#333;border:none;padding:5px 10px;border-radius:5px;cursor:pointer">关闭</button>
          `;
          document.body.appendChild(testDiv);
          return;
        }

        // 在页面上显示测试结果
        const testDiv = document.createElement('div');
        testDiv.style.cssText = `
          position: fixed;
          top: 50px;
          right: 50px;
          background: #4CAF50;
          color: white;
          padding: 20px;
          border-radius: 10px;
          z-index: 10000;
          font-size: 16px;
          max-width: 300px;
          box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        `;
        testDiv.innerHTML = `
          <h3>API测试结果</h3>
          <p><strong>原文:</strong> Hello world</p>
          <p><strong>翻译:</strong> ${finalText}</p>
          <button onclick="this.parentElement.remove()" style="background:#fff;color:#333;border:none;padding:5px 10px;border-radius:5px;cursor:pointer">关闭</button>
        `;
        document.body.appendChild(testDiv);

        // 3秒后自动移除
        setTimeout(() => {
          if (testDiv.parentElement) {
            testDiv.remove();
          }
        }, 5000);
      },
      onError: (msg) => {
        stat(`API测试失败: ${msg}`);
        console.error('API测试失败:', msg);
      }
    });
  }

  function quickTest(){
    saveCfg();
    stat('快速测试中...');

    // 找到页面上的第一个标题或段落
    const testText = document.querySelector('h1, h2, h3, p')?.textContent?.trim();
    if (!testText) {
      stat('未找到测试文本');
      return;
    }

    const shortText = testText.substring(0, 100);
    console.log('快速测试文本:', shortText);

    // 先测试简单的文本
    const testReq = streamGenerate({
      url: CFG.apiUrl,
      body: {
        model: CFG.model,
        prompt: `Translate to ${CFG.targetLang}: "Hello world"`,
        stream: true,
        options: { temperature: 0 }
      },
      onChunk: (delta, total) => {
        if (debugMode) console.log('快速测试响应:', total);
      },
      onDone: (finalText) => {
        stat(`快速测试成功: ${finalText}`);
        console.log('快速测试完成:', finalText);

        // 检查翻译结果是否为空
        if (!finalText || finalText.trim() === '') {
          console.error('翻译结果为空，可能是API问题');
          stat('翻译结果为空，请检查API配置');

          // 显示错误信息
          const testDiv = document.createElement('div');
          testDiv.style.cssText = `
            position: fixed;
            top: 100px;
            right: 50px;
            background: #f44336;
            color: white;
            padding: 20px;
            border-radius: 10px;
            z-index: 10000;
            font-size: 16px;
            max-width: 400px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
          `;
          testDiv.innerHTML = `
            <h3>翻译失败</h3>
            <p><strong>原文:</strong> ${shortText}</p>
            <p><strong>错误:</strong> 翻译结果为空</p>
            <p><strong>可能原因:</strong></p>
            <ul style="text-align:left;margin:10px 0;">
              <li>Ollama服务未运行</li>
              <li>模型名称错误</li>
              <li>API地址错误</li>
              <li>网络连接问题</li>
            </ul>
            <button onclick="this.parentElement.remove()" style="background:#fff;color:#333;border:none;padding:5px 10px;border-radius:5px;cursor:pointer">关闭</button>
          `;
          document.body.appendChild(testDiv);
          return;
        }

        // 在页面上显示测试结果
        const testDiv = document.createElement('div');
        testDiv.style.cssText = `
          position: fixed;
          top: 100px;
          right: 50px;
          background: #2196F3;
          color: white;
          padding: 20px;
          border-radius: 10px;
          z-index: 10000;
          font-size: 16px;
          max-width: 400px;
          box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        `;
        testDiv.innerHTML = `
          <h3>快速翻译测试</h3>
          <p><strong>原文:</strong> ${shortText}</p>
          <p><strong>翻译:</strong> ${finalText}</p>
          <button onclick="this.parentElement.remove()" style="background:#fff;color:#333;border:none;padding:5px 10px;border-radius:5px;cursor:pointer">关闭</button>
        `;
        document.body.appendChild(testDiv);

        // 5秒后自动移除
        setTimeout(() => {
          if (testDiv.parentElement) {
            testDiv.remove();
          }
        }, 8000);
      },
      onError: (msg) => {
        stat(`快速测试失败: ${msg}`);
        console.error('快速测试失败:', msg);

        // 显示详细错误信息
        const testDiv = document.createElement('div');
        testDiv.style.cssText = `
          position: fixed;
          top: 100px;
          right: 50px;
          background: #f44336;
          color: white;
          padding: 20px;
          border-radius: 10px;
          z-index: 10000;
          font-size: 16px;
          max-width: 400px;
          box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        `;
        testDiv.innerHTML = `
          <h3>API连接失败</h3>
          <p><strong>错误信息:</strong> ${msg}</p>
          <p><strong>API地址:</strong> ${CFG.apiUrl}</p>
          <p><strong>模型:</strong> ${CFG.model}</p>
          <p><strong>请检查:</strong></p>
          <ul style="text-align:left;margin:10px 0;">
            <li>Ollama是否正在运行？</li>
            <li>API地址是否正确？</li>
            <li>模型是否已安装？</li>
            <li>防火墙是否阻止连接？</li>
          </ul>
          <button onclick="this.parentElement.remove()" style="background:#fff;color:#333;border:none;padding:5px 10px;border-radius:5px;cursor:pointer">关闭</button>
        `;
        document.body.appendChild(testDiv);
      }
    });
  }

  // ----------- Ollama 流式请求（逐行 JSON） -----------
  function streamGenerate({url, body, onChunk, onDone, onError}){
    let acc = '';
    let lastIndex = 0;
    let isDone = false;

    if (debugMode) {
      console.log('发送API请求:', {url, body});
    }

    const req = GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: {'Content-Type': 'application/json'},
      data: JSON.stringify(body),
                   onprogress: (res) => {
             if (debugMode) {
               console.log('onprogress响应对象:', res);
               console.log('onprogress响应文本:', res?.responseText);
               console.log('onprogress响应状态:', res?.status);
               console.log('onprogress响应头:', res?.responseHeaders);
             }

             const text = res.responseText || '';
             const slice = text.slice(lastIndex);
             lastIndex = text.length;

             if (debugMode) {
               console.log('收到响应片段:', slice);
               console.log('完整响应文本:', text);
               console.log('响应长度:', text.length);
               console.log('片段长度:', slice.length);
             }

        // 检查是否是完整的JSON响应（非流式）
        if (text.trim() && text.trim().startsWith('{') && text.trim().endsWith('}')) {
          try {
            const obj = JSON.parse(text.trim());

            if (debugMode) {
              console.log('解析完整JSON:', obj);
            }

            // 处理响应文本 - 支持多种可能的字段名
            let responseText = null;
            if (typeof obj.response === 'string' && obj.response) {
              responseText = obj.response;
            } else if (typeof obj.content === 'string' && obj.content) {
              responseText = obj.content;
            } else if (typeof obj.text === 'string' && obj.text) {
              responseText = obj.text;
            } else if (typeof obj.message === 'string' && obj.message) {
              responseText = obj.message;
            }

            if (responseText) {
              acc = responseText; // 直接使用响应文本，不累积
              onChunk?.(responseText, acc);
              if (debugMode) {
                console.log('完整响应文本:', acc);
              }

              // 检查是否完成
              const isCompleted = obj.done || obj.finished || obj.complete || obj.end;
              if (isCompleted && !isDone) {
                isDone = true;
                if (debugMode) {
                  console.log('翻译完成，最终结果:', acc.trim());
                }
                onDone?.(acc.trim());
              }
            } else {
              if (debugMode) {
                console.warn('响应中没有找到文本内容:', obj);
              }
            }
          } catch(e) {
            if (debugMode) {
              console.warn('解析完整JSON失败:', text, e);
            }
          }
          return;
        }

        // 原有的流式解析逻辑（用于真正的流式响应）
        for (const line of slice.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);

            if (debugMode) {
              console.log('解析流式JSON:', obj);
            }

            // 处理响应文本 - 支持多种可能的字段名
            let responseText = null;
            if (typeof obj.response === 'string' && obj.response) {
              responseText = obj.response;
            } else if (typeof obj.content === 'string' && obj.content) {
              responseText = obj.content;
            } else if (typeof obj.text === 'string' && obj.text) {
              responseText = obj.text;
            } else if (typeof obj.message === 'string' && obj.message) {
              responseText = obj.message;
            }

            if (responseText) {
              acc += responseText;
              onChunk?.(responseText, acc);
              if (debugMode) {
                console.log('累积文本:', acc);
              }
            }

            // 检查是否完成 - 支持多种完成标志
            const isCompleted = obj.done || obj.finished || obj.complete || obj.end;
            if (isCompleted && !isDone) {
              isDone = true;
              if (debugMode) {
                console.log('翻译完成，最终结果:', acc.trim());
              }
              onDone?.(acc.trim());
            }
          } catch(e) {
            if (debugMode) {
              console.warn('解析响应失败:', line, e);
            }
            // 忽略未完整的行
          }
        }
      },
      onload: (res) => {
        if (debugMode) {
          console.log('请求完成，最终累积结果:', acc.trim());
          console.log('isDone状态:', isDone);
          console.log('acc内容:', acc);
          console.log('onload响应对象:', res);
          console.log('onload响应文本:', res?.responseText);
          console.log('onload响应状态:', res?.status);
          console.log('onload响应头:', res?.responseHeaders);
        }

        // 如果onprogress没有被触发，在onload中处理响应
        if (!isDone && res?.responseText) {
          if (debugMode) {
            console.log('在onload中处理响应数据');
          }

          const text = res.responseText;

          // 检查是否是完整的JSON响应（非流式）
          if (text.trim() && text.trim().startsWith('{') && text.trim().endsWith('}')) {
            try {
              const obj = JSON.parse(text.trim());

              if (debugMode) {
                console.log('解析完整JSON:', obj);
              }

              // 处理响应文本 - 支持多种可能的字段名
              let responseText = null;
              if (typeof obj.response === 'string' && obj.response) {
                responseText = obj.response;
              } else if (typeof obj.content === 'string' && obj.content) {
                responseText = obj.content;
              } else if (typeof obj.text === 'string' && obj.text) {
                responseText = obj.text;
              } else if (typeof obj.message === 'string' && obj.message) {
                responseText = obj.message;
              }

              if (responseText) {
                acc = responseText;
                onChunk?.(responseText, acc);
                if (debugMode) {
                  console.log('完整响应文本:', acc);
                }

                // 检查是否完成
                const isCompleted = obj.done || obj.finished || obj.complete || obj.end;
                if (isCompleted) {
                  isDone = true;
                  if (debugMode) {
                    console.log('翻译完成，最终结果:', acc.trim());
                  }
                  onDone?.(acc.trim());
                  return;
                }
              }
            } catch(e) {
              if (debugMode) {
                console.warn('解析完整JSON失败:', text, e);
              }
            }
          }

          // 处理流式JSON响应（每行一个JSON对象）
          const lines = text.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);

              if (debugMode) {
                console.log('解析流式JSON:', obj);
              }

              // 处理响应文本 - 支持多种可能的字段名
              let responseText = null;
              if (typeof obj.response === 'string' && obj.response) {
                responseText = obj.response;
              } else if (typeof obj.content === 'string' && obj.content) {
                responseText = obj.content;
              } else if (typeof obj.text === 'string' && obj.text) {
                responseText = obj.text;
              } else if (typeof obj.message === 'string' && obj.message) {
                responseText = obj.message;
              }

              if (responseText) {
                acc += responseText;
                onChunk?.(responseText, acc);
                if (debugMode) {
                  console.log('累积文本:', acc);
                }
              }

              // 检查是否完成 - 支持多种完成标志
              const isCompleted = obj.done || obj.finished || obj.complete || obj.end;
              if (isCompleted && !isDone) {
                isDone = true;
                if (debugMode) {
                  console.log('翻译完成，最终结果:', acc.trim());
                }
                onDone?.(acc.trim());
                return;
              }
            } catch(e) {
              if (debugMode) {
                console.warn('解析响应失败:', line, e);
              }
              // 忽略未完整的行
            }
          }
        }

        // 如果还没有完成，调用onDone
        if (!isDone) {
          if (debugMode) {
            console.log('调用onDone回调，参数:', acc.trim());
          }
          onDone?.(acc.trim());
        } else {
          if (debugMode) {
            console.log('请求已完成，跳过onDone调用');
          }
        }
      },
      onerror: (e) => {
        if (debugMode) {
          console.error('请求错误:', e);
        }
        onError?.(e.error || 'network error');
      },
      ontimeout: () => {
        if (debugMode) {
          console.error('请求超时');
        }
        onError?.('timeout');
      },
      timeout: 120000
    });
    return req;
  }

  // ----------- 工具 -----------
  function dragEnable(handle, box){
    let sx=0, sy=0, ox=0, oy=0, dragging=false;
    handle.addEventListener('mousedown', (e)=>{ dragging=true; sx=e.clientX; sy=e.clientY; const r=box.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault(); });
    window.addEventListener('mousemove', (e)=>{ if(!dragging) return; box.style.left=(ox+e.clientX-sx)+'px'; box.style.top=(oy+e.clientY-sy)+'px'; });
    window.addEventListener('mouseup', ()=> dragging=false);
  }
})();
