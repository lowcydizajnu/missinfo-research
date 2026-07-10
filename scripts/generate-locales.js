'use strict';

// Load .env manually to handle potential BOM/encoding issues
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  });
}

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function translateLocale(plJson, targetLang) {
  const langNames = { en: 'English', cs: 'Czech', sk: 'Slovak' };
  console.log(`Translating to ${langNames[targetLang]}...`);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Translate the following JSON locale file from Polish to ${langNames[targetLang]}.
Keep all JSON keys exactly the same. Only translate the string values.
Keep emojis and special characters (→, ←, –) as-is.
Return ONLY valid JSON, no markdown, no explanation.

${JSON.stringify(plJson, null, 2)}`
    }]
  });
  let text = response.content[0].text.trim();
  // Strip markdown code fences if model wrapped the JSON
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  return JSON.parse(text);
}

async function main() {
  const localesDir = path.join(__dirname, '..', 'public', 'locales');
  const plPath = path.join(localesDir, 'pl.json');
  const plJson = JSON.parse(fs.readFileSync(plPath, 'utf8'));

  for (const lang of ['en', 'cs', 'sk']) {
    const translated = await translateLocale(plJson, lang);
    const outPath = path.join(localesDir, `${lang}.json`);
    fs.writeFileSync(outPath, JSON.stringify(translated, null, 2), 'utf8');
    console.log(`Written: ${outPath}`);
  }

  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
