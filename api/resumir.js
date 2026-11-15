/* Aulalia · Resumidor de apuntes · endpoint de servidor (Vercel Serverless Function, Node 18+)
   No guarda ninguna clave. Cada persona escribe la suya en la herramienta (Anthropic, OpenAI, Google,
   DeepSeek o xAI/Grok) y llega aquí solo para reenviarla al proveedor elegido en esa misma petición.
   No se registra ni se almacena. Los prompts viven aquí para que el endpoint no sea un chat genérico.
   Variable opcional: ALLOWED_ORIGIN = tu dominio. */

const LIMITS = { sources: 450000, text: 60000, notes: 200000, per_min: 8 };
const hits = new Map(); // limitador sencillo por IP (en memoria; en producción usa Upstash/Redis)

const RULES = `Eres el motor de Aulalia, una herramienta que convierte los materiales de clase de un estudiante en apuntes de estudio completos, redactados como si los hubiera hecho él mismo. Escribe siempre en español.

REGLAS DE FIDELIDAD (prioridad máxima)
- La información de los materiales del profesor tiene prioridad absoluta. Un libro solo sirve para ampliar y desarrollar lo que el profesor plantea.
- No inventes datos, fechas, nombres ni acontecimientos. No completes con suposiciones. No añadas información externa a los documentos aportados.
- Si un dato no está suficientemente explicado en los documentos, no lo inventes: omítelo o indícalo con "(no se detalla en los materiales)".
- Si dos documentos se contradicen, señala la discrepancia en una línea que empiece por "⚠ Discrepancia:".
- Respeta exactamente los límites de contenido que se pidan: no resumas lo anterior ni lo posterior.

ESTILO
- Lenguaje claro y natural, manteniendo el vocabulario académico y los términos específicos.
- Combina párrafos explicativos con listas y viñetas. No lo conviertas todo en esquemas ni abuses de listas de palabras sueltas.
- Explica las relaciones entre acontecimientos, conceptos y personajes. Evita repeticiones y relleno.
- Detalle suficiente para preparar un examen sin volver a los originales. No elimines información importante solo para acortar.

ORGANIZACIÓN (Markdown)
- Una línea "# TEMA N. TÍTULO" (o "# TÍTULO" si no hay número), después "## 1. APARTADO", "### 1.1. Subapartado", "## 2. SIGUIENTE APARTADO"...
- Negritas (**...**) para fechas, nombres, conceptos y acontecimientos importantes. Viñetas para clasificaciones, características, causas y consecuencias. Párrafos para desarrollar.
- Sigue la estructura del material del profesor. No inventes apartados innecesarios ni reordenes sin motivo.

SELECCIÓN
- Incluye siempre: fechas, personajes y autores, definiciones, conceptos, causas y consecuencias, características, etapas y cronologías, leyes, tratados y acontecimientos, ejemplos importantes y lo que pueda caer en un examen.
- Reduce: repeticiones, explicaciones redundantes, anécdotas y datos secundarios sin valor.

ADAPTACIÓN POR ASIGNATURA
- Historia: orden cronológico, causas y consecuencias (políticas, económicas, sociales, territoriales), etapas, personajes, guerras, revoluciones y tratados.
- Literatura: movimientos, etapas, autores y obras, características, temas, estilo y estructura, diferencias entre autores.
- Biología y ciencias: definiciones, procesos, clasificaciones, estructuras, funciones y relaciones entre conceptos.
- Filosofía: autores, corrientes, teorías, conceptos, argumentos y comparaciones entre pensadores.
- Otras asignaturas: adapta la forma de resumir a lo que cada materia necesita.

TRAZABILIDAD
- Los documentos llegan etiquetados como [D1], [D2]... y con marcas de página "[[D1·p.4]]". Tras cada párrafo o viñeta que contenga un dato relevante, añade al final la marca de procedencia con el formato ⟦D1·p.4⟧ (o ⟦D1·p.4-5⟧, ⟦D1·p.4;D2·p.9⟧). Usa solo documentos y páginas que existan. Sin otro texto dentro de las marcas.`;

const DET = { breve: 'BREVE: solo lo esencial, unos pocos párrafos y listas por apartado.', medio: 'MEDIO: equilibrio entre síntesis y desarrollo.', detallado: 'DETALLADO: desarrollo completo, para estudiar sin consultar los originales.' };

function ctx(b) {
  const c = b.config || {}, p = b.prefs || {}, out = [];
  if (c.asignatura) out.push('Asignatura: ' + c.asignatura);
  if (c.titulo) out.push('Título del tema: ' + c.titulo);
  out.push('Nivel de detalle: ' + (DET[c.detalle] || DET.detallado));
  if (c.partes > 1) out.push(`El tema se divide en ${c.partes} partes de extensión equilibrada, siguiendo los apartados del material. Genera SOLO la parte ${c.parte} de ${c.partes}. No resumas lo anterior ni lo posterior y no repitas lo que corresponde a otras partes.`);
  if (c.desde || c.hasta) out.push(`Límites exactos del contenido a resumir. Empieza en: «${c.desde || 'el principio'}». Termina en: «${c.hasta || 'el final'}».`);
  if (c.instr) out.push('Instrucciones adicionales del estudiante: ' + c.instr);
  if (p.estilo) out.push('Preferencias de redacción del estudiante: ' + p.estilo);
  if (p.ejemplo) out.push('EJEMPLO DE APUNTES PROPIOS (imita solo el estilo y la organización, NO uses su contenido como fuente):\n"""\n' + String(p.ejemplo).slice(0, 8000) + '\n"""');
  return out.join('\n');
}

const OPS = {
  generate: b => ({ system: RULES, max: 16000, user: `${ctx(b)}\n\nMATERIALES:\n${b.sources}\n\nGenera ahora los apuntes completos en Markdown, siguiendo todas las reglas. Devuelve solo los apuntes.` }),
  continue: b => ({ system: RULES, max: 16000, user: `${ctx(b)}\n\nMATERIALES:\n${b.sources}\n\nAPUNTES YA ESCRITOS (quedaron incompletos):\n${b.notes}\n\nContinúa exactamente donde se cortaron, sin repetir nada y sin volver a escribir el título. Devuelve solo la continuación en Markdown.` }),
  review: b => ({ system: 'Eres un revisor riguroso de apuntes. Comparas unos apuntes con los documentos originales y respondes SOLO con JSON válido, sin texto antes ni después.', max: 3000, user: `${ctx(b)}\n\nMATERIALES ORIGINALES:\n${b.sources}\n\nAPUNTES A REVISAR:\n${b.notes}\n\nComprueba: 1) se cubre todo el contenido solicitado; 2) no se omiten datos importantes; 3) fechas y nombres son correctos según los documentos; 4) no hay contradicciones; 5) los apartados están ordenados; 6) la extensión es equilibrada; 7) se mantiene el estilo pedido; 8) no hay información externa no autorizada.\nResponde con este JSON: {"checks":[{"n":1,"ok":true,"nota":"..."} ... hasta 8],"problemas":[{"seccion":"título del apartado","detalle":"qué falla y cómo corregirlo"}]}. "nota" y "detalle" deben ser breves y concretos.` }),
  fix: b => ({ system: RULES, max: 16000, user: `${ctx(b)}\n\nMATERIALES:\n${b.sources}\n\nAPUNTES ACTUALES:\n${b.notes}\n\nOBSERVACIONES DE LA REVISIÓN:\n${b.issues}\n\nDevuelve los apuntes completos corregidos en Markdown. Aplica solo las correcciones necesarias y conserva todo lo demás tal cual, incluidas las ediciones manuales del estudiante.` }),
  section: b => {
    const A = {
      ampliar: 'Amplía y desarrolla más la explicación usando los documentos originales. No añadas nada que no esté en ellos.',
      simplificar: 'Explica el contenido de forma más sencilla sin perder información importante.',
      resumir: 'Reduce la extensión manteniendo lo fundamental (fechas, nombres, definiciones).',
      corregir: 'Mejora la redacción y corrige errores de ortografía y expresión sin cambiar el contenido.',
      explicar: 'Desarrolla este concepto difícil para que se entienda mejor, apoyándote en los documentos.',
      añadir: 'Incorpora información relevante que aparezca en los documentos originales y falte en el texto.',
      regenerar: 'Escribe otra versión de este apartado a partir de los documentos originales, con el mismo estilo.'
    };
    if (!A[b.action]) throw new Error('Acción no válida');
    return { system: RULES, max: 6000, user: `${ctx(b)}\n\n${b.sources ? 'MATERIALES:\n' + b.sources + '\n\n' : ''}APARTADO: ${b.titulo || '(sin título)'}\nTEXTO A TRABAJAR:\n"""\n${b.text}\n"""\n\nTAREA: ${A[b.action]}${b.extra ? '\nIndicación del estudiante: ' + b.extra : ''}\nRespeta el estilo general de los apuntes. Devuelve SOLO el texto resultante en Markdown, sin el título del apartado, sin comillas y sin comentarios.` };
  }
};

const PROV = {
  anthropic: { model: 'claude-sonnet-5-5' },
  openai: { model: 'gpt-4.1', url: 'https://api.openai.com/v1/chat/completions', tok: 'max_completion_tokens' },
  google: { model: 'gemini-2.5-flash' },
  deepseek: { model: 'deepseek-chat', url: 'https://api.deepseek.com/chat/completions', tok: 'max_tokens', cap: 8000 },
  grok: { model: 'grok-4', url: 'https://api.x.ai/v1/chat/completions', tok: 'max_tokens' }
};

async function ask(system, user, max, ai) {
  const P = PROV[ai.provider]; if (!P) throw new Error('Proveedor de IA no válido');
  const key = String(ai.key || '').trim(); if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw new Error('Clave de API no válida');
  const model = String(ai.model || P.model).trim(); if (!/^[\w.:\-\/]{1,80}$/.test(model)) throw new Error('Nombre de modelo no válido');
  max = Math.min(max, P.cap || max);
  let r, j;
  if (ai.provider === 'anthropic') {
    r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: max, system, messages: [{ role: 'user', content: user }] }) });
    j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(errMsg(j, r));
    return { text: (j.content || []).filter(x => x.type === 'text').map(x => x.text).join(''), truncated: j.stop_reason === 'max_tokens' };
  }
  if (ai.provider === 'google') {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: max } }) });
    j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(errMsg(j, r));
    const c = j.candidates && j.candidates[0]; if (!c) throw new Error('Google no devolvió respuesta (puede haberla bloqueado)');
    return { text: ((c.content && c.content.parts) || []).map(x => x.text || '').join(''), truncated: c.finishReason === 'MAX_TOKENS' };
  }
  r = await fetch(P.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model, [P.tok]: max, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(errMsg(j, r));
  const c = j.choices && j.choices[0]; return { text: (c && c.message && c.message.content) || '', truncated: !!c && c.finish_reason === 'length' };
}
const errMsg = (j, r) => r.status === 401 || r.status === 403 ? 'El proveedor rechazó la clave de API (revisa que sea correcta y tenga saldo).' : (j && ((j.error && (j.error.message || j.error)) || j.message)) || 'Error del proveedor de IA (' + r.status + ')';

module.exports = async (req, res) => {
  const o = process.env.ALLOWED_ORIGIN;
  if (o) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'x', now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < 60000); if (h.length >= LIMITS.per_min) return res.status(429).json({ error: 'Demasiadas peticiones. Espera un minuto.' });
  h.push(now); hits.set(ip, h);
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (!OPS[b.op]) return res.status(400).json({ error: 'Operación no válida' });
    for (const [k, m] of [['sources', LIMITS.sources], ['text', LIMITS.text], ['notes', LIMITS.notes]]) if (b[k] != null && (typeof b[k] !== 'string' || b[k].length > m)) return res.status(413).json({ error: `«${k}» demasiado largo` });
    const t = OPS[b.op](b);
    return res.status(200).json(await ask(t.system, t.user, t.max, b.ai || {}));
  } catch (e) { return res.status(500).json({ error: e.message || 'Error interno' }); }
};
