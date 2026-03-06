// =============================================================================
// CustomerMaxing.com — Cloudflare Worker API
// ES Modules format
//
// AI Model: Google Gemini 2.0 Flash-Lite
//
// NOTE (Twilio Voice): Currently uses basic <Gather input="speech"> for STT.
// ConversationRelay can be added later for better voice quality — it requires
// WebSocket support via Durable Objects which adds complexity. The <Gather>
// approach works well for the prototype.
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return corsResponse(request, new Response(null, { status: 204 }));
    }

    try {
      let response;

      // Health check
      if (path === '/api/health' && method === 'GET') {
        response = json({ status: 'ok', service: 'customermaxing-api' });
      }

      // --- Twilio Webhooks (no auth required — Twilio signs these) ---
      else if (path === '/api/twilio/incoming' && method === 'POST') {
        response = await handleIncomingCall(request, env);
      }
      else if (path === '/api/twilio/ai-answer' && method === 'POST') {
        response = await handleAiAnswer(request, env);
      }
      else if (path === '/api/twilio/ai-respond' && method === 'POST') {
        response = await handleAiRespond(request, env);
      }
      else if (path === '/api/twilio/status' && method === 'POST') {
        response = await handleCallStatus(request, env);
      }

      // --- REST API (auth required) ---
      else if (path.startsWith('/api/')) {
        const user = await authenticateUser(request, env);
        if (!user) {
          response = json({ error: 'Unauthorized' }, 401);
        } else {
          response = await handleRestApi(path, method, request, env, user, url);
        }
      }

      else {
        response = json({ error: 'Not found' }, 404);
      }

      return corsResponse(request, response);
    } catch (err) {
      console.error('Unhandled error:', err);
      return corsResponse(request, json({ error: 'Internal server error' }, 500));
    }
  }
};

// =============================================================================
// CORS
// =============================================================================

function corsResponse(request, response) {
  const origin = request.headers.get('Origin') || '';
  const allowed = origin.match(/^https?:\/\/(.*\.)?customermaxing\.com$/) || origin === 'http://localhost:3000';

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowed ? origin : 'https://customermaxing.com');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// =============================================================================
// HELPERS
// =============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function twiml(body) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

function escapeXml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function parseFormData(request) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  const data = {};
  for (const [key, value] of params) {
    data[key] = value;
  }
  return data;
}

// Supabase query helper using service role key (bypasses RLS)
async function supabase(env, path, options = {}) {
  const { method = 'GET', body, headers: extraHeaders = {}, single = false } = options;
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  if (single) {
    headers['Accept'] = 'application/vnd.pgrst.object+json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Supabase error [${res.status}] ${path}:`, errText);
    throw new Error(`Supabase error: ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('json')) {
    return res.json();
  }
  return null;
}

// =============================================================================
// GEMINI AI HELPER
// =============================================================================

async function callGemini(env, systemPrompt, messages, maxOutputTokens = 300) {
  // Convert messages from {role: 'user'|'assistant', content} to Gemini format
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          maxOutputTokens,
          temperature: 0.7,
        },
      }),
    }
  );

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error('Gemini API error:', errText);
    return null;
  }

  const data = await geminiRes.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// =============================================================================
// AUTHENTICATION
// =============================================================================

async function authenticateUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  try {
    // Verify token with Supabase auth
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_ANON_KEY,
      },
    });

    if (!res.ok) return null;
    const authUser = await res.json();

    // Get cm_users record to get client_id
    const users = await supabase(env, `cm_users?id=eq.${authUser.id}&select=*`, { single: true });
    if (!users) return null;

    return {
      id: authUser.id,
      email: authUser.email,
      client_id: users.client_id,
      client_slug: users.client_slug,
      role: users.role,
    };
  } catch (err) {
    console.error('Auth error:', err);
    return null;
  }
}

// =============================================================================
// TWILIO WEBHOOKS
// =============================================================================

async function handleIncomingCall(request, env) {
  const form = await parseFormData(request);
  const calledNumber = form.To;
  const callerNumber = form.From;
  const callSid = form.CallSid;

  // Look up client by Twilio phone number
  let client;
  try {
    client = await supabase(env, `cm_clients?phone_number=eq.${encodeURIComponent(calledNumber)}&select=*`, { single: true });
  } catch {
    // No client found for this number
    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">We're sorry, this number is not configured. Goodbye.</Say>
  <Hangup/>
</Response>`);
  }

  // Log the call
  await supabase(env, 'cm_calls', {
    method: 'POST',
    body: {
      client_id: client.id,
      twilio_call_sid: callSid,
      caller_phone: callerNumber,
      status: 'missed', // will be updated on completion
      started_at: new Date().toISOString(),
    },
  });

  // Get available team members ordered by routing
  const teamMembers = await supabase(env,
    `cm_team_members?client_id=eq.${client.id}&is_available=eq.true&order=routing_order.asc&select=*`
  );

  // Build TwiML: try each team member sequentially, then fall back to AI
  let dialSteps = '';
  for (const member of teamMembers) {
    dialSteps += `
  <Dial timeout="30" action="/api/twilio/ai-answer?client_id=${client.id}&amp;call_sid=${encodeURIComponent(callSid)}">
    <Number>${escapeXml(member.phone_number)}</Number>
  </Dial>`;
  }

  // If no team members, go straight to AI
  if (teamMembers.length === 0) {
    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/twilio/ai-answer?client_id=${client.id}&amp;call_sid=${encodeURIComponent(callSid)}</Redirect>
</Response>`);
  }

  // The last Dial's action will trigger ai-answer if nobody picks up.
  // For intermediate dials, Twilio follows the action URL on no-answer.
  // We redirect to ai-answer from the action of each dial.
  return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">${escapeXml(client.greeting_message || 'Please hold while we connect you.')}</Say>
  ${dialSteps}
  <Redirect method="POST">/api/twilio/ai-answer?client_id=${client.id}&amp;call_sid=${encodeURIComponent(callSid)}</Redirect>
</Response>`);
}

async function handleAiAnswer(request, env) {
  const form = await parseFormData(request);
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') || form.client_id;
  const callSid = url.searchParams.get('call_sid') || form.call_sid || form.CallSid;

  // Check if the dial was answered (DialCallStatus)
  if (form.DialCallStatus === 'completed' || form.DialCallStatus === 'answered') {
    // A team member answered — update call record
    await supabase(env, `cm_calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}`, {
      method: 'PATCH',
      body: {
        handled_by: 'team_member',
        status: 'completed',
      },
    });
    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response/>`)
  }

  // Nobody answered — AI picks up
  let client;
  try {
    client = await supabase(env, `cm_clients?id=eq.${clientId}&select=*`, { single: true });
  } catch {
    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">We're sorry, we're unable to assist right now. Please try again later.</Say>
  <Hangup/>
</Response>`);
  }

  // Update call to AI-handled
  await supabase(env, `cm_calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}`, {
    method: 'PATCH',
    body: {
      handled_by: 'ai',
      handled_by_name: 'AI Assistant',
    },
  });

  const greeting = client.greeting_message || 'Hello! How can I help you today?';

  // Store initial AI message in conversation
  try {
    const calls = await supabase(env, `cm_calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}&select=id`);
    if (calls.length > 0) {
      await supabase(env, 'cm_call_messages', {
        method: 'POST',
        body: {
          call_id: calls[0].id,
          role: 'ai',
          content: greeting,
        },
      });
    }
  } catch (err) {
    console.error('Error storing greeting message:', err);
  }

  return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">${escapeXml(greeting)}</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/api/twilio/ai-respond?client_id=${clientId}&amp;call_sid=${encodeURIComponent(callSid)}" method="POST">
    <Say voice="Google.en-US-Neural2-F">I'm listening.</Say>
  </Gather>
  <Say voice="Google.en-US-Neural2-F">I didn't hear anything. Goodbye.</Say>
  <Hangup/>
</Response>`);
}

async function handleAiRespond(request, env) {
  const form = await parseFormData(request);
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') || form.client_id;
  const callSid = url.searchParams.get('call_sid') || form.call_sid || form.CallSid;
  const speechResult = form.SpeechResult || '';
  const callerPhone = form.From || form.Caller || '';

  if (!speechResult.trim()) {
    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">I didn't catch that. Could you please repeat?</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/api/twilio/ai-respond?client_id=${clientId}&amp;call_sid=${encodeURIComponent(callSid)}" method="POST">
  </Gather>
  <Say voice="Google.en-US-Neural2-F">I still didn't hear anything. Goodbye.</Say>
  <Hangup/>
</Response>`);
  }

  // Get client info
  let client;
  try {
    client = await supabase(env, `cm_clients?id=eq.${clientId}&select=*`, { single: true });
  } catch {
    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">I'm sorry, I'm having trouble right now. Please call back later.</Say>
  <Hangup/>
</Response>`);
  }

  // Get the call record
  let callRecord;
  try {
    const calls = await supabase(env, `cm_calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}&select=id`);
    callRecord = calls.length > 0 ? calls[0] : null;
  } catch {
    callRecord = null;
  }

  // Store caller message
  if (callRecord) {
    await supabase(env, 'cm_call_messages', {
      method: 'POST',
      body: { call_id: callRecord.id, role: 'caller', content: speechResult },
    });
  }

  // Check for escalation phrases
  const escalationRules = client.escalation_rules || {};
  const escalationPhrases = escalationRules.escalation_phrases || ['speak to a person', 'talk to someone', 'representative', 'manager'];
  const lowerSpeech = speechResult.toLowerCase();
  const wantsEscalation = escalationPhrases.some(phrase => lowerSpeech.includes(phrase));

  if (wantsEscalation) {
    if (callRecord) {
      await supabase(env, 'cm_call_messages', {
        method: 'POST',
        body: { call_id: callRecord.id, role: 'ai', content: 'Caller requested to speak with a person. Offering callback option.' },
      });
    }

    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">I understand you'd like to speak with someone directly. Unfortunately, no team members are available right now. I can submit your question and have someone call you back as soon as possible. Would you like that, or is there something else I can help you with?</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/api/twilio/ai-respond?client_id=${clientId}&amp;call_sid=${encodeURIComponent(callSid)}" method="POST">
  </Gather>
  <Hangup/>
</Response>`);
  }

  // Get conversation history for context
  let conversationHistory = [];
  if (callRecord) {
    try {
      const messages = await supabase(env,
        `cm_call_messages?call_id=eq.${callRecord.id}&order=timestamp.asc&select=role,content`
      );
      conversationHistory = messages;
    } catch {
      // Continue without history
    }
  }

  // Query knowledge base for relevant entries
  let kbEntries = [];
  try {
    kbEntries = await supabase(env,
      `cm_knowledge_base?client_id=eq.${clientId}&select=title,category,content`
    );
  } catch {
    // Continue without KB
  }

  // Build knowledge base context
  const kbContext = kbEntries.length > 0
    ? kbEntries.map(e => `[${e.category.toUpperCase()}] ${e.title}\n${e.content}`).join('\n\n---\n\n')
    : 'No knowledge base entries available.';

  // Build conversation messages for Gemini
  const toneMap = {
    professional: 'Respond in a professional, courteous tone.',
    friendly: 'Respond in a warm, friendly tone.',
    casual: 'Respond in a casual, conversational tone.',
  };

  const systemPrompt = `You are an AI phone assistant for ${client.name}. ${toneMap[client.ai_tone] || toneMap.professional}

Your job is to answer the caller's questions using ONLY the knowledge base provided below. Be concise — your response will be spoken aloud over the phone, so keep it under 3-4 sentences unless the question requires more detail.

KNOWLEDGE BASE:
${kbContext}

RULES:
- Only answer based on the knowledge base. If the answer is not in the knowledge base, say you don't have that information and offer to have someone call them back.
- If the caller asks for a link, URL, payment page, or form, mention you'll send it via text message and include the URL in your response wrapped in [SMS: url_here] tags.
- Never make up information. Never guess at prices, policies, or procedures not in the knowledge base.
- Be helpful, natural, and conversational. Remember this is a phone call.
- If you truly cannot help, offer two options: (1) submit the question for a callback, or (2) hold for the next available person.`;

  const geminiMessages = [];

  // Add conversation history
  for (const msg of conversationHistory) {
    if (msg.role === 'caller') {
      geminiMessages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'ai') {
      geminiMessages.push({ role: 'assistant', content: msg.content });
    }
  }

  // Add the current message
  geminiMessages.push({ role: 'user', content: speechResult });

  // Call Gemini API
  let aiResponse = "I'm sorry, I'm having trouble processing your request right now. Would you like me to have someone call you back?";
  try {
    const geminiText = await callGemini(env, systemPrompt, geminiMessages, 300);
    if (geminiText) {
      aiResponse = geminiText;
    }
  } catch (err) {
    console.error('Gemini API call failed:', err);
  }

  // Check for SMS links in the response
  const smsMatch = aiResponse.match(/\[SMS:\s*(.+?)\]/g);
  if (smsMatch && callerPhone) {
    for (const match of smsMatch) {
      const link = match.replace(/\[SMS:\s*/, '').replace(/\]$/, '').trim();
      // Send SMS via Twilio
      try {
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
        await fetch(twilioUrl, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            From: client.phone_number,
            To: callerPhone,
            Body: `Here's the link you requested: ${link}`,
          }).toString(),
        });
      } catch (err) {
        console.error('Failed to send SMS:', err);
      }
    }
    // Clean SMS tags from spoken response
    aiResponse = aiResponse.replace(/\[SMS:\s*.+?\]/g, '').trim();
    if (aiResponse) {
      aiResponse += " I've also sent you a text message with the link.";
    } else {
      aiResponse = "I've sent you a text message with the link you requested.";
    }
  }

  // Store AI response in conversation
  if (callRecord) {
    await supabase(env, 'cm_call_messages', {
      method: 'POST',
      body: { call_id: callRecord.id, role: 'ai', content: aiResponse },
    });
  }

  // Respond with TwiML — say the response and gather more input
  return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">${escapeXml(aiResponse)}</Say>
  <Gather input="speech" timeout="6" speechTimeout="auto" action="/api/twilio/ai-respond?client_id=${clientId}&amp;call_sid=${encodeURIComponent(callSid)}" method="POST">
    <Say voice="Google.en-US-Neural2-F">Is there anything else I can help you with?</Say>
  </Gather>
  <Say voice="Google.en-US-Neural2-F">Thank you for calling ${escapeXml(client.name)}. Have a great day!</Say>
  <Hangup/>
</Response>`);
}

async function handleCallStatus(request, env) {
  const form = await parseFormData(request);
  const callSid = form.CallSid;
  const callStatus = form.CallStatus;       // completed, busy, no-answer, failed, canceled
  const callDuration = form.CallDuration;
  const recordingUrl = form.RecordingUrl;

  if (!callSid) return json({ ok: true });

  const updates = {
    ended_at: new Date().toISOString(),
  };

  if (callDuration) updates.duration_seconds = parseInt(callDuration, 10);
  if (recordingUrl) updates.recording_url = recordingUrl;

  if (callStatus === 'completed') {
    updates.status = 'completed';
  } else if (callStatus === 'no-answer') {
    updates.status = 'missed';
  } else if (callStatus === 'busy' || callStatus === 'failed' || callStatus === 'canceled') {
    updates.status = 'missed';
  }

  try {
    await supabase(env, `cm_calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}`, {
      method: 'PATCH',
      body: updates,
    });

    // Generate AI summary from conversation
    const calls = await supabase(env, `cm_calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}&select=id,handled_by`);
    if (calls.length > 0 && calls[0].handled_by === 'ai') {
      const messages = await supabase(env,
        `cm_call_messages?call_id=eq.${calls[0].id}&order=timestamp.asc&select=role,content`
      );

      if (messages.length > 0) {
        const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');

        // Generate summary via Gemini
        try {
          const summary = await callGemini(
            env,
            'Summarize this phone call transcript in 1-2 sentences. Focus on what the caller wanted and the outcome.',
            [{ role: 'user', content: transcript }],
            200
          );

          if (summary) {
            await supabase(env, `cm_calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}`, {
              method: 'PATCH',
              body: {
                transcript: transcript,
                ai_summary: summary,
              },
            });
          }
        } catch (err) {
          console.error('Summary generation failed:', err);
        }
      }
    }
  } catch (err) {
    console.error('Call status update failed:', err);
  }

  return json({ ok: true });
}

// =============================================================================
// REST API ROUTER
// =============================================================================

async function handleRestApi(path, method, request, env, user, url) {
  const clientId = user.client_id;

  // Parse path segments
  const segments = path.replace('/api/', '').split('/').filter(Boolean);
  const resource = segments[0];
  const resourceId = segments[1];

  // --- CALLS ---
  if (resource === 'calls') {
    if (method === 'GET' && !resourceId) {
      return getCalls(env, clientId, url);
    }
    if (method === 'GET' && resourceId) {
      return getCall(env, clientId, resourceId);
    }
  }

  // --- KNOWLEDGE BASE ---
  if (resource === 'knowledge-base') {
    if (method === 'GET' && !resourceId) {
      return getKnowledgeBase(env, clientId, url);
    }
    if (method === 'POST') {
      return createKbEntry(request, env, clientId);
    }
    if (method === 'PUT' && resourceId) {
      return updateKbEntry(request, env, clientId, resourceId);
    }
    if (method === 'DELETE' && resourceId) {
      return deleteKbEntry(env, clientId, resourceId);
    }
  }

  // --- TEAM MEMBERS ---
  if (resource === 'team-members') {
    if (method === 'GET' && !resourceId) {
      return getTeamMembers(env, clientId);
    }
    if (method === 'POST') {
      return createTeamMember(request, env, clientId);
    }
    if (method === 'PUT' && resourceId) {
      return updateTeamMember(request, env, clientId, resourceId);
    }
    if (method === 'DELETE' && resourceId) {
      return deleteTeamMember(env, clientId, resourceId);
    }
  }

  // --- DASHBOARD STATS ---
  if (resource === 'dashboard' && segments[1] === 'stats') {
    return getDashboardStats(env, clientId);
  }

  // --- SETTINGS ---
  if (resource === 'settings') {
    if (method === 'GET') {
      return getSettings(env, clientId);
    }
    if (method === 'PUT') {
      return updateSettings(request, env, clientId);
    }
  }

  return json({ error: 'Not found' }, 404);
}

// =============================================================================
// CALLS
// =============================================================================

async function getCalls(env, clientId, url) {
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;
  const status = url.searchParams.get('status');

  let query = `cm_calls?client_id=eq.${clientId}&order=created_at.desc&limit=${limit}&offset=${offset}&select=id,twilio_call_sid,caller_phone,caller_name,duration_seconds,status,handled_by,handled_by_name,ai_summary,satisfaction_score,started_at,ended_at,created_at`;

  if (status) {
    query += `&status=eq.${status}`;
  }

  // Get count header
  const countRes = await fetch(`${env.SUPABASE_URL}/rest/v1/cm_calls?client_id=eq.${clientId}&select=id`, {
    method: 'HEAD',
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer': 'count=exact',
    },
  });
  const total = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0', 10);

  const calls = await supabase(env, query);

  return json({
    data: calls,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

async function getCall(env, clientId, callId) {
  try {
    const call = await supabase(env,
      `cm_calls?id=eq.${callId}&client_id=eq.${clientId}&select=*`,
      { single: true }
    );

    // Get messages
    const messages = await supabase(env,
      `cm_call_messages?call_id=eq.${callId}&order=timestamp.asc&select=*`
    );

    return json({ ...call, messages });
  } catch {
    return json({ error: 'Call not found' }, 404);
  }
}

// =============================================================================
// KNOWLEDGE BASE
// =============================================================================

async function getKnowledgeBase(env, clientId, url) {
  const category = url.searchParams.get('category');
  let query = `cm_knowledge_base?client_id=eq.${clientId}&order=created_at.desc&select=id,title,category,content,created_at,updated_at`;
  if (category) query += `&category=eq.${category}`;

  const entries = await supabase(env, query);
  return json({ data: entries });
}

async function createKbEntry(request, env, clientId) {
  const body = await request.json();
  const { title, category, content } = body;

  if (!title || !content) {
    return json({ error: 'title and content are required' }, 400);
  }

  const entry = await supabase(env, 'cm_knowledge_base', {
    method: 'POST',
    body: { client_id: clientId, title, category: category || 'faq', content },
    headers: { 'Prefer': 'return=representation' },
  });

  return json(entry, 201);
}

async function updateKbEntry(request, env, clientId, entryId) {
  const body = await request.json();
  const { title, category, content } = body;
  const updates = {};
  if (title !== undefined) updates.title = title;
  if (category !== undefined) updates.category = category;
  if (content !== undefined) updates.content = content;

  const result = await supabase(env,
    `cm_knowledge_base?id=eq.${entryId}&client_id=eq.${clientId}`,
    { method: 'PATCH', body: updates, headers: { 'Prefer': 'return=representation' } }
  );

  return json(result);
}

async function deleteKbEntry(env, clientId, entryId) {
  await supabase(env,
    `cm_knowledge_base?id=eq.${entryId}&client_id=eq.${clientId}`,
    { method: 'DELETE' }
  );
  return json({ ok: true });
}

// =============================================================================
// TEAM MEMBERS
// =============================================================================

async function getTeamMembers(env, clientId) {
  const members = await supabase(env,
    `cm_team_members?client_id=eq.${clientId}&order=routing_order.asc&select=*`
  );
  return json({ data: members });
}

async function createTeamMember(request, env, clientId) {
  const body = await request.json();
  const { name, phone_number, routing_order, is_available } = body;

  if (!name || !phone_number) {
    return json({ error: 'name and phone_number are required' }, 400);
  }

  const member = await supabase(env, 'cm_team_members', {
    method: 'POST',
    body: {
      client_id: clientId,
      name,
      phone_number,
      routing_order: routing_order || 1,
      is_available: is_available !== undefined ? is_available : true,
    },
    headers: { 'Prefer': 'return=representation' },
  });

  return json(member, 201);
}

async function updateTeamMember(request, env, clientId, memberId) {
  const body = await request.json();
  const { name, phone_number, routing_order, is_available } = body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (phone_number !== undefined) updates.phone_number = phone_number;
  if (routing_order !== undefined) updates.routing_order = routing_order;
  if (is_available !== undefined) updates.is_available = is_available;

  const result = await supabase(env,
    `cm_team_members?id=eq.${memberId}&client_id=eq.${clientId}`,
    { method: 'PATCH', body: updates, headers: { 'Prefer': 'return=representation' } }
  );

  return json(result);
}

async function deleteTeamMember(env, clientId, memberId) {
  await supabase(env,
    `cm_team_members?id=eq.${memberId}&client_id=eq.${clientId}`,
    { method: 'DELETE' }
  );
  return json({ ok: true });
}

// =============================================================================
// DASHBOARD STATS
// =============================================================================

async function getDashboardStats(env, clientId) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  // Calls today
  const callsToday = await supabase(env,
    `cm_calls?client_id=eq.${clientId}&created_at=gte.${todayStart}&select=id,handled_by,duration_seconds,status`
  );

  const totalToday = callsToday.length;
  const aiHandled = callsToday.filter(c => c.handled_by === 'ai').length;
  const aiHandledPct = totalToday > 0 ? Math.round((aiHandled / totalToday) * 100) : 0;

  const completedCalls = callsToday.filter(c => c.duration_seconds > 0);
  const avgDuration = completedCalls.length > 0
    ? Math.round(completedCalls.reduce((sum, c) => sum + c.duration_seconds, 0) / completedCalls.length)
    : 0;

  const missedToday = callsToday.filter(c => c.status === 'missed').length;

  // Calls this week (last 7 days)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const callsWeek = await supabase(env,
    `cm_calls?client_id=eq.${clientId}&created_at=gte.${weekAgo}&select=id`
  );

  return json({
    today: {
      total: totalToday,
      ai_handled: aiHandled,
      ai_handled_pct: aiHandledPct,
      missed: missedToday,
      avg_duration_seconds: avgDuration,
    },
    this_week: {
      total: callsWeek.length,
    },
  });
}

// =============================================================================
// SETTINGS
// =============================================================================

async function getSettings(env, clientId) {
  const settings = await supabase(env,
    `cm_settings?client_id=eq.${clientId}&select=key,value`
  );

  // Also return client config
  let client;
  try {
    client = await supabase(env, `cm_clients?id=eq.${clientId}&select=*`, { single: true });
  } catch {
    client = null;
  }

  const settingsMap = {};
  for (const s of settings) {
    settingsMap[s.key] = s.value;
  }

  return json({ client, settings: settingsMap });
}

async function updateSettings(request, env, clientId) {
  const body = await request.json();

  // Update client-level fields if provided
  const clientFields = ['name', 'greeting_message', 'ai_tone', 'business_hours', 'max_hold_time_seconds', 'escalation_rules'];
  const clientUpdates = {};
  for (const field of clientFields) {
    if (body[field] !== undefined) {
      clientUpdates[field] = body[field];
    }
  }

  if (Object.keys(clientUpdates).length > 0) {
    await supabase(env, `cm_clients?id=eq.${clientId}`, {
      method: 'PATCH',
      body: clientUpdates,
    });
  }

  // Update key-value settings if provided
  if (body.settings && typeof body.settings === 'object') {
    for (const [key, value] of Object.entries(body.settings)) {
      // Upsert: try update, then insert
      const existing = await supabase(env,
        `cm_settings?client_id=eq.${clientId}&key=eq.${encodeURIComponent(key)}&select=id`
      );

      if (existing.length > 0) {
        await supabase(env,
          `cm_settings?id=eq.${existing[0].id}`,
          { method: 'PATCH', body: { value } }
        );
      } else {
        await supabase(env, 'cm_settings', {
          method: 'POST',
          body: { client_id: clientId, key, value },
        });
      }
    }
  }

  return json({ ok: true });
}
