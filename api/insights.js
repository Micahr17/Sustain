/* =====================================================================
   POST /api/insights

   Runs on Vercel as a serverless function. It exists for one reason: the
   Anthropic API key must never reach the browser. Anything in index.html
   is readable by anyone who opens View Source, so the key lives in a
   Vercel environment variable and only this file ever sees it.

   The prompt and schema live here too, not in the browser. This endpoint
   is public — anyone who finds the URL can call it and spend the owner's
   credits. Because the request body is built here from a validated list
   of nights, a stranger cannot use it as a free general-purpose Claude
   proxy: they can only ask this one question about sleep data.
   ===================================================================== */

var MODEL = 'claude-sonnet-4-6';
var MAX_NIGHTS = 14;
var MAX_TOKENS = 8000;

/* Numeric thresholds, not adjectives. A model told to "find patterns"
   will find them in noise, because finding something feels more helpful
   than finding nothing. Vague hedging instructions barely move that;
   arithmetic tests it can actually fail do. */
var SYSTEM_PROMPT = [
  'You analyse a personal sleep journal. Each record pairs what someone did during one evening with how they slept that night.',
  '',
  'Your job is to report only what the data supports, and to say plainly when it supports nothing.',
  '',
  'Restedness ratings scatter widely on their own. On this 1-10 scale the night-to-night spread has a standard deviation near 3 points, so with only three or four nights in a group, differences of one or two points appear constantly in data with no relationship at all. Treat small gaps as what they almost always are: noise.',
  '',
  'Hard rules:',
  '1. A pattern requires at least 3 nights WITH the behaviour and at least 3 nights WITHOUT it. Fewer than that on either side: do not report it.',
  '2. Required gap in mean restedness, which depends on how much data there is:',
  '   - Fewer than 14 nights total: the gap must be at least 4.0 points. Anything under 4.0 at this sample size is indistinguishable from chance, however clean the split looks.',
  '   - 14 nights or more: the gap must be at least 1.5 points.',
  '3. Confidence ceiling by sample size, regardless of how large the gap looks:',
  '   - Fewer than 14 nights total: "low" is the maximum. Never say "medium" or "high".',
  '   - 14 to 20 nights: "medium" is the maximum, and needs 5+ nights on each side.',
  '   - 21+ nights: "high" is available, and needs 7+ nights each side and a gap of 2.0+.',
  '4. Check for overlap before claiming anything. If the individual restedness values of the two groups interleave — the worst night without the behaviour is worse than the best night with it — the means are being pulled by one or two outliers and this is not a pattern. Say nothing.',
  '5. Check for confounding. If two or more tags appear on nearly the same nights, their effects cannot be separated. Report at most one of them, and state in the evidence that it cannot be distinguished from the tags it travels with. Never report several tags that are really the same handful of nights described differently.',
  '6. Every claim must cite concrete evidence from the data: the two group means, the number of nights in each group, or specific dates. Never write evidence that cannot be checked against the records provided.',
  '7. Records with lateEntry set to true were rated from memory hours or days afterwards. Treat them as weaker evidence, and say so if a pattern leans on them.',
  '8. Report at most 3 patterns. Fewer is normal. Zero is a correct answer.',
  '',
  'A single week is a small sample. With fewer than 10 nights, report a pattern only if it is overwhelming: a gap of 4.0 or more, groups that do not overlap at all, and no other tag tracking the same nights. Anything less than overwhelming is chance, and an empty result is the expected outcome rather than a disappointing one.',
  '',
  'A useful check before you answer: ask whether this same split could plausibly have come from ratings assigned at random. Seven nights of random numbers on a 1-10 scale routinely produce two-point and three-point gaps between arbitrary groups. If your finding is the kind of thing random data would produce, it is not a finding.',
  '',
  'If nothing clears these bars, return an empty patterns array and set insufficientData to true. This is a success, not a failure. Do not soften it by reporting a weak pattern anyway. Do not invent an encouraging observation to be helpful. An honest "not enough signal yet" is more useful to this person than a plausible-sounding correlation that is not there.',
  '',
  'The note field is one short sentence of plain context - what you looked at, or what would make the next analysis stronger. No advice, no encouragement, no medical claims.'
].join('\n');

/* Enforced by the API through output_config.format, so the model cannot
   reply with prose, markdown fences, or extra keys. */
var SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: ['claim', 'evidence', 'confidence'],
        additionalProperties: false
      }
    },
    insufficientData: { type: 'boolean' },
    note: { type: 'string' }
  },
  required: ['patterns', 'insufficientData', 'note'],
  additionalProperties: false
};

/* Best-effort throttle. Serverless instances come and go, so this only
   slows down a burst hitting one warm instance — it is a speed bump, not
   a guarantee. Real protection would need a shared store. */
var hits = Object.create(null);
function throttled(ip) {
  var now = Date.now();
  var window = 60 * 1000;
  var limit = 10;
  var list = (hits[ip] || []).filter(function (t) { return now - t < window; });
  list.push(now);
  hits[ip] = list;
  return list.length > limit;
}

function clampScore(v) {
  var n = Math.round(Number(v));
  if (!isFinite(n)) return 0;
  return Math.min(10, Math.max(1, n));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'This deployment has no ANTHROPIC_API_KEY. Add it under Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  var ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (throttled(ip)) {
    return res.status(429).json({ error: 'Too many analyses in a short time. Try again in a minute.' });
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { return res.status(400).json({ error: 'Body was not valid JSON.' }); }
  }
  if (!body || !Array.isArray(body.nights) || !body.nights.length) {
    return res.status(400).json({ error: 'Send { nights: [ ... ] }.' });
  }
  if (body.nights.length > MAX_NIGHTS) {
    return res.status(400).json({ error: 'At most ' + MAX_NIGHTS + ' nights per request.' });
  }

  // Rebuild every night from scratch: only these fields, only these types,
  // so nothing arbitrary reaches the model no matter what was posted.
  var nights = body.nights.map(function (n) {
    return {
      date: String(n && n.date || '').slice(0, 10),
      tags: Array.isArray(n && n.tags) ? n.tags.slice(0, 20).map(function (t) { return String(t).slice(0, 40); }) : [],
      note: String(n && n.note || '').slice(0, 200),
      sleepQuality: clampScore(n && n.sleepQuality),
      restedness: clampScore(n && n.restedness),
      wokeDuringNight: !!(n && n.wokeDuringNight),
      lateEntry: !!(n && n.lateEntry)
    };
  });

  var userMsg =
    (body.control ? 'These records are randomly generated test data with no real relationship between behaviour and sleep.\n\n' : '') +
    'Here are ' + nights.length + ' complete nights as JSON. Restedness and sleepQuality are 1-10.\n\n' +
    JSON.stringify(nights);

  try {
    var upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    var data = null;
    try { data = await upstream.json(); } catch (err) { data = null; }

    if (!upstream.ok) {
      var detail = data && data.error && data.error.message ? data.error.message : 'Anthropic returned ' + upstream.status + '.';
      // The key itself is never echoed back, only the reason.
      return res.status(upstream.status === 401 ? 500 : upstream.status).json({ error: detail });
    }
    if (data && data.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'The model declined this request.' });
    }

    var text = (data && Array.isArray(data.content) ? data.content : [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('')
      .trim();

    if (!text) return res.status(502).json({ error: 'The model returned no text.' });

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      var start = text.indexOf('{'), end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return res.status(502).json({ error: 'The model did not return JSON.' });
      try { parsed = JSON.parse(text.slice(start, end + 1)); }
      catch (err2) { return res.status(502).json({ error: 'The model did not return JSON.' }); }
    }

    return res.status(200).json({
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 3) : [],
      insufficientData: !!parsed.insufficientData,
      note: typeof parsed.note === 'string' ? parsed.note : '',
      nightsAnalysed: nights.length
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach the model: ' + err.message });
  }
};
