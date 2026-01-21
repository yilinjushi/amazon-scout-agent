
/**
 * 服务器自动化脚本 - 每周新品扫描
 * 
 * 运行方式:
 * 1. 确保安装了 Node.js (v18+)
 * 2. 安装依赖: npm install @google/genai dotenv
 * 3. 设置环境变量: API_KEY, EMAIL_SERVICE_ID, EMAIL_TEMPLATE_ID, EMAIL_PUBLIC_KEY, EMAIL_PRIVATE_KEY
 * 4. 运行: node server/weekly_task.mjs
 */

import { GoogleGenAI } from "@google/genai";
import fs from 'node:fs';
import path from 'node:path';

// --- 配置区域 ---
const CONFIG = {
  // 核心逻辑：所有凭证必须来自环境变量
  geminiKey: process.env.API_KEY, 
  emailServiceId: process.env.EMAIL_SERVICE_ID,
  emailTemplateId: process.env.EMAIL_TEMPLATE_ID,
  emailPublicKey: process.env.EMAIL_PUBLIC_KEY,
  // 新增：EmailJS 私钥 (在 REST API 中对应 accessToken)
  emailPrivateKey: process.env.EMAIL_PRIVATE_KEY,
  
  recipientEmail: 'icyfire.info@gmail.com',
  historyFile: './server/history.json'
};

const COMPANY_PROFILE = {
  name: 'IcyFire Tech Solutions',
  techStackSummary: [
    'Sensors: Temp/Humidity (SHT/NTC), MEMS, Bio-impedance, Hall Effect',
    'Connectivity: BLE, WiFi (Tuya/ESP), SubG',
    'Output: LCD/LED, Motor/Servo, Audio',
    'Algorithms: PID, Pedometer'
  ]
};

// --- 0. 历史记录管理 ---
function loadHistory() {
  try {
    if (fs.existsSync(CONFIG.historyFile)) {
      const data = fs.readFileSync(CONFIG.historyFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn("读取历史记录失败，将创建新记录:", e.message);
  }
  return [];
}

function saveHistory(newProducts) {
  try {
    const history = loadHistory();
    const newNames = newProducts.map(p => p.name);
    // 合并并去重
    const updatedHistory = [...new Set([...history, ...newNames])];
    
    // 确保目录存在
    const dir = path.dirname(CONFIG.historyFile);
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CONFIG.historyFile, JSON.stringify(updatedHistory, null, 2));
    console.log(`已更新历史记录。当前数据库包含 ${updatedHistory.length} 个产品。`);
  } catch (e) {
    console.error("保存历史记录失败:", e);
  }
}

// 检查配置完整性
function validateConfig() {
  const missing = [];
  if (!CONFIG.geminiKey) missing.push('API_KEY');
  if (!CONFIG.emailServiceId) missing.push('EMAIL_SERVICE_ID');
  if (!CONFIG.emailTemplateId) missing.push('EMAIL_TEMPLATE_ID');
  if (!CONFIG.emailPublicKey) missing.push('EMAIL_PUBLIC_KEY');
  // 检查私钥
  if (!CONFIG.emailPrivateKey) missing.push('EMAIL_PRIVATE_KEY');

  if (missing.length > 0) {
    throw new Error(`配置缺失，请在环境变量中设置: ${missing.join(', ')}`);
  }
}

// --- 1. Gemini AI 扫描逻辑 ---
async function scoutProducts() {
  console.log("正在启动 Gemini 扫描...");
  const ai = new GoogleGenAI({ apiKey: CONFIG.geminiKey });

  // 加载黑名单
  const history = loadHistory();
  const exclusionContext = history.length > 0 
    ? `**STRICT EXCLUSION LIST (DO NOT SUGGEST):** ${history.join(', ')}` 
    : '';

  console.log(`加载了 ${history.length} 个历史产品进行排除。`);

  const prompt = `
    Perform a product scan on Amazon US for ${COMPANY_PROFILE.name}.
    Tech Stack: ${JSON.stringify(COMPANY_PROFILE.techStackSummary)}
    
    **STRATEGY: GENERATE CANDIDATES & FILTER**
    Please identify **9 distinct electronic products** (I will select the best 6).
    
    **REQUIREMENT:** Identify distinct electronic products.
    Target Categories: Smart Home, Health, Pet Supplies, Tools.
    
    ${exclusionContext}
    
    **OUTPUT FORMAT (JSON ONLY, Values in Simplified Chinese):**
    {
      "summary": "本周趋势分析摘要（中文）",
      "products": [
        {
          "name": "产品名称",
          "price": "$XX.XX",
          "amazonRating": "4.5",
          "description": "功能简介",
          "matchScore": 85,
          "reasoning": "推荐理由...",
          "requiredTech": ["技术1", "技术2"],
          "url": "https://...",
          "imageUrl": "Product Image URL (Try to find a representative image URL, else leave empty)"
        }
      ]
    }
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
      },
    });

    const jsonText = response.text || "{}";
    const cleanJson = jsonText.replace(/```json/g, '').replace(/```/g, '');
    const data = JSON.parse(cleanJson);
    
    let rawProducts = data.products || [];

    // --- CODE-LEVEL DEDUPLICATION ---
    // 强制过滤，防止 AI 幻觉导致重复
    const normalizedHistory = new Set(history.map(h => h.trim().toLowerCase()));
    
    const uniqueProducts = rawProducts.filter(p => {
        const normalizedName = p.name.trim().toLowerCase();
        const isDuplicate = normalizedHistory.has(normalizedName);
        if (isDuplicate) console.log(`[Filter] Detected duplicate: ${p.name}`);
        return !isDuplicate;
    });

    // 截取前 6 个
    const finalProducts = uniqueProducts.slice(0, 6);
    
    console.log(`AI 生成了 ${rawProducts.length} 个，过滤后剩余 ${uniqueProducts.length} 个，最终选取 ${finalProducts.length} 个。`);

    // 更新 data 对象以返回
    data.products = finalProducts;
    
    return {
      date: new Date().toLocaleDateString(),
      ...data
    };
  } catch (error) {
    console.error("Gemini 扫描失败:", error);
    throw error;
  }
}

// --- 2. 邮件发送逻辑 (EmailJS) ---
async function sendEmail(report) {
  console.log("正在构建邮件内容 (HTML)...");
  
  // 构建 HTML 邮件
  const emailHtml = `
<div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 800px;">
  <p>Hi Team,</p>
  <p>以下是本周的亚马逊（美国）新产品机会摘要 (服务器自动扫描)，已根据我们的研发能力进行筛选。</p>

  <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #2563eb; margin: 20px 0;">
    <h3 style="margin: 0 0 10px 0; color: #1e293b;">执行摘要 (EXECUTIVE SUMMARY)</h3>
    <p style="margin: 0; font-size: 14px; color: #475569;">${report.summary}</p>
  </div>

  <h3 style="border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-top: 30px;">
    已识别的机会 (IDENTIFIED OPPORTUNITIES) - ${report.products.length} 项
  </h3>

  ${report.products.map((p, i) => `
    <div style="border-bottom: 1px solid #eee; padding: 20px 0;">
      <h3 style="color: #2563eb; margin: 0 0 10px 0;">#${i + 1}: ${p.name}</h3>
      
      ${p.imageUrl ? `
        <div style="margin: 15px 0;">
          <img src="${p.imageUrl}" alt="${p.name}" style="max-width: 300px; max-height: 200px; border-radius: 8px; object-fit: cover; border: 1px solid #e2e8f0;" />
        </div>
      ` : ''}

      <div style="background-color: #f1f5f9; padding: 10px; border-radius: 6px; font-size: 14px; margin-bottom: 10px;">
        <strong>匹配度:</strong> ${p.matchScore}/100 
        <span style="margin: 0 10px;">|</span> 
        <strong>价格:</strong> ${p.price || 'N/A'} 
        <span style="margin: 0 10px;">|</span> 
        <strong>评分:</strong> ${p.amazonRating || 'N/A'}
      </div>

      <p style="margin: 5px 0;">
        <strong>链接:</strong> <a href="${p.url || '#'}" style="color: #2563eb; text-decoration: underline;">${p.url || '未找到链接'}</a>
      </p>

      <p style="margin: 10px 0; font-style: italic; color: #555;">
        <strong>推荐理由:</strong> ${p.reasoning}
      </p>

      <p style="margin: 10px 0; font-size: 13px;">
        <strong>所需技术栈:</strong> 
        <span style="font-family: monospace; color: #059669; background: #ecfdf5; padding: 2px 6px; border-radius: 4px;">
          ${p.requiredTech.join(' / ')}
        </span>
      </p>
    </div>
  `).join('')}

  <div style="margin-top: 30px; font-size: 14px; color: #64748b;">
    <p><strong>后续行动:</strong></p>
    <ol style="margin-top: 5px;">
      <li>查看“匹配度”以评估技术可行性。</li>
      <li>点击链接分析竞品功能。</li>
    </ol>
  </div>

  <p style="margin-top: 30px; font-size: 14px; color: #94a3b8;">
    此致,<br/>
    Amazon Product Scout Agent (Server Bot)
  </p>
</div>
  `;

  const url = 'https://api.emailjs.com/api/v1.0/email/send';
  const data = {
    service_id: CONFIG.emailServiceId,
    template_id: CONFIG.emailTemplateId,
    user_id: CONFIG.emailPublicKey,
    accessToken: CONFIG.emailPrivateKey, // EmailJS REST API 使用 accessToken 传递 Private Key
    template_params: {
      to_email: CONFIG.recipientEmail,
      subject: `[自动周报] 亚马逊产品侦察 - ${report.date}`,
      message: emailHtml,
    }
  };

  console.log("正在发送邮件至:", CONFIG.recipientEmail);
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }
  console.log("邮件发送成功!");
}

// --- 主执行函数 ---
async function main() {
  try {
    validateConfig(); // 先检查配置
    const report = await scoutProducts();
    console.log(`扫描完成，找到 ${report.products.length} 个产品。`);
    
    // 保存历史记录 (在发送邮件前保存，防止邮件发送失败导致数据丢失)
    if (report.products.length > 0) {
        saveHistory(report.products);
    }
    
    await sendEmail(report);
    console.log("任务全部完成。");
    process.exit(0);
  } catch (e) {
    console.error("任务失败:", e.message);
    process.exit(1);
  }
}

main();

