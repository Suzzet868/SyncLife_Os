const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');

const { obtenerClima, convertirMoneda, analizarNutricion, generarDiagnostico, guardarRegistroDB } = require('./synclife');

const app = express();
app.use(cors());
app.use(express.json());

function readLocalEnvironment() {
  if (!fs.existsSync(envPath)) return {};
  const fileEnvironment = {};
  fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return;
    fileEnvironment[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  });
  return fileEnvironment;
}

function getAIConfig() {
  const fileEnvironment = readLocalEnvironment();
  const getValue = (name) => (process.env[name] || fileEnvironment[name] || '').trim();
  const provider = (getValue('AI_PROVIDER') || 'gemini').toLowerCase();
  const settings = {
    gemini: { apiKey: getValue('GEMINI_API_KEY'), model: getValue('GEMINI_MODEL') || 'gemini-3.8-flash' },
    openai: { apiKey: getValue('OPENAI_API_KEY'), model: getValue('OPENAI_MODEL') || 'gpt-4o-mini' },
  };
  if (!settings[provider]) {
    const error = new Error('AI_PROVIDER debe ser "gemini" o "openai" en backend/.env.');
    error.status = 503;
    throw error;
  }
  return { provider, ...settings[provider] };
}

async function generateWithAI(prompt) {
  const { provider, apiKey, model } = getAIConfig();
  if (!apiKey) {
    const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
    const error = new Error(`Configura ${keyName} en backend/.env para usar ${provider === 'gemini' ? 'Gemini' : 'OpenAI'}.`);
    error.status = 503;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const request = provider === 'gemini'
      ? {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        headers: { 'Content-Type': 'application/json' },
        body: {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.6 },
        },
      }
      : {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: {
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.6,
        },
      };
    const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        signal: controller.signal,
        body: JSON.stringify(request.body),
      });
    const result = await response.json();
    if (!response.ok) {
      console.error(`${provider} devolvió un error:`, result.error?.message || response.status);
      const providerName = provider === 'gemini' ? 'Gemini' : 'OpenAI';
      const apiError = result.error?.message || '';
      const invalidKey = /api.?key|invalid.*key|key.*invalid/i.test(apiError);
      const message = response.status === 401 || response.status === 403 || invalidKey
        ? `La clave de ${providerName} fue rechazada. Verifica que sea válida y que tenga habilitada la API.`
        : response.status === 429
          ? `Se alcanzó el límite o la cuota de ${providerName}. Revisa la facturación y vuelve a intentarlo más tarde.`
          : response.status === 404 && provider === 'gemini'
            ? `Gemini no encontró el modelo "${model}" (404). Revisa GEMINI_MODEL en las variables de Vercel; prueba con gemini-3.8-flash y vuelve a desplegar.`
          : `${providerName} no pudo generar la recomendación. Verifica la clave, el modelo y los límites de la API${apiError ? ` (${response.status}).` : '.'}`;
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const text = provider === 'gemini'
      ? result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('')
      : result.choices?.[0]?.message?.content;
    if (!text) {
      const error = new Error(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} devolvió una respuesta vacía.`);
      error.status = 502;
      throw error;
    }
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch (parseError) {
      const error = new Error(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} devolvió un formato que no se pudo leer. Inténtalo otra vez.`);
      error.status = 502;
      throw error;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} tardó demasiado en responder. Inténtalo otra vez.`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/synclife/ai/status', (req, res) => {
  try {
    const config = getAIConfig();
    return res.json({
      provider: config.provider,
      model: config.model,
      configured: Boolean(config.apiKey),
      missingKey: config.apiKey ? null : config.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY',
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/synclife/weather', async (req, res) => {
  const ciudad = typeof req.query.city === 'string' && req.query.city.trim()
    ? req.query.city.trim().slice(0, 100)
    : 'Cusco';
  return res.json(await obtenerClima(ciudad));
});

function getPortionGrams(portion) {
  const text = portion.trim().replace(',', '.');
  const withUnit = text.match(/(\d+(?:\.\d+)?)\s*(kg|g|gr|gramos?|oz|onzas?|lb|libras?)\b/i);
  const amount = Number(withUnit?.[1] || text.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = withUnit?.[2]?.toLowerCase();
  const factor = unit === 'kg' ? 1000
    : ['oz', 'onza', 'onzas'].includes(unit) ? 28.3495
      : ['lb', 'libra', 'libras'].includes(unit) ? 453.592
        : 1;
  return Math.min(amount * factor, 10000);
}

const localNutritionReferences = [
  { terms: ['res', 'bistec', 'beef'], fiberG: 0, sodiumMg: 72, addedSugarG: 0, micronutrients: 'hierro ~2.6 mg, zinc ~4.8 mg' },
  { terms: ['pollo', 'chicken', 'pavo', 'turkey'], fiberG: 0, sodiumMg: 74, addedSugarG: 0, micronutrients: 'hierro ~1 mg, zinc ~1 mg' },
  { terms: ['salmon', 'salmón', 'pescado', 'fish', 'atun', 'atún'], fiberG: 0, sodiumMg: 59, addedSugarG: 0, micronutrients: 'potasio ~360 mg, selenio ~25 µg' },
  { terms: ['carne'], fiberG: 0, sodiumMg: 75, addedSugarG: 0, micronutrients: 'hierro ~2 mg, zinc ~4 mg' },
  { terms: ['arroz', 'rice'], fiberG: 0.4, sodiumMg: 1, addedSugarG: 0, micronutrients: 'magnesio ~12 mg, hierro ~0.2 mg' },
  { terms: ['lenteja', 'lentil', 'frejol', 'frijol', 'bean', 'garbanzo', 'chickpea'], fiberG: 7.5, sodiumMg: 2, addedSugarG: 0, micronutrients: 'hierro ~2.5 mg, magnesio ~40 mg' },
  { terms: ['avena', 'oat'], fiberG: 10.6, sodiumMg: 2, addedSugarG: 0, micronutrients: 'hierro ~4.3 mg, magnesio ~177 mg' },
  { terms: ['huevo', 'egg'], fiberG: 0, sodiumMg: 142, addedSugarG: 0, micronutrients: 'hierro ~1.2 mg, vitamina B12 ~1.1 µg' },
  { terms: ['platano', 'plátano', 'banana', 'banano'], fiberG: 2.6, sodiumMg: 1, addedSugarG: 0, micronutrients: 'potasio ~358 mg, vitamina B6 ~0.4 mg' },
  { terms: ['manzana', 'apple'], fiberG: 2.4, sodiumMg: 1, addedSugarG: 0, micronutrients: 'potasio ~107 mg, vitamina C ~5 mg' },
  { terms: ['papa', 'patata', 'potato'], fiberG: 2.2, sodiumMg: 6, addedSugarG: 0, micronutrients: 'potasio ~425 mg, vitamina C ~20 mg' },
  { terms: ['quinua', 'quinoa'], fiberG: 2.8, sodiumMg: 7, addedSugarG: 0, micronutrients: 'magnesio ~64 mg, hierro ~1.5 mg' },
  { terms: ['brocoli', 'brócoli', 'broccoli'], fiberG: 2.6, sodiumMg: 33, addedSugarG: 0, micronutrients: 'vitamina C ~89 mg, potasio ~316 mg' },
  { terms: ['leche', 'milk'], fiberG: 0, sodiumMg: 44, addedSugarG: 0, micronutrients: 'calcio ~125 mg, potasio ~150 mg' },
];

function findLocalNutritionReference(food) {
  const normalizedFood = food.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return localNutritionReferences.find(({ terms }) => terms.some((term) => {
    const normalizedTerm = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return normalizedFood.includes(normalizedTerm);
  }));
}

function estimateFromOpenFoodFacts(product, portionGrams) {
  const nutrients = product.nutriments || {};
  const multiplier = portionGrams / 100;
  const per100g = (...keys) => {
    for (const key of keys) {
      if (nutrients[key] === null || nutrients[key] === undefined || nutrients[key] === '') continue;
      const value = Number(nutrients[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return null;
  };
  const fiber = per100g('fiber_100g');
  const sodium = per100g('sodium_100g');
  const addedSugar = per100g('added-sugars_100g', 'added_sugars_100g');
  const micros = [
    ['hierro', 'iron_100g', 'mg'],
    ['calcio', 'calcium_100g', 'mg'],
    ['potasio', 'potassium_100g', 'mg'],
    ['magnesio', 'magnesium_100g', 'mg'],
    ['vitamina C', 'vitamin-c_100g', 'mg'],
    ['zinc', 'zinc_100g', 'mg'],
  ].flatMap(([label, key, fallbackUnit]) => {
    if (nutrients[key] === null || nutrients[key] === undefined || nutrients[key] === '') return [];
    const value = Number(nutrients[key]);
    if (!Number.isFinite(value) || value <= 0) return [];
    const unit = nutrients[`${key.replace(/_100g$/, '')}_unit`] || fallbackUnit;
    const scaled = value * multiplier;
    const normalizedValue = unit === 'g' && fallbackUnit === 'mg' ? scaled * 1000 : scaled;
    const normalizedUnit = unit === 'g' && fallbackUnit === 'mg' ? 'mg' : unit;
    return [`${label} ~${Number(normalizedValue.toFixed(1))} ${normalizedUnit}`];
  }).slice(0, 3);

  if (fiber === null && sodium === null && addedSugar === null && micros.length === 0) return null;
  return {
    fiberG: fiber === null ? null : Number((fiber * multiplier).toFixed(1)),
    sodiumMg: sodium === null ? null : Math.round(sodium * multiplier * 1000),
    addedSugarG: addedSugar === null ? null : Number((addedSugar * multiplier).toFixed(1)),
    micronutrients: micros.join(', '),
    basis: `Datos de ${product.product_name || 'Open Food Facts'} por 100 g, ajustados a ${portionGrams} g; la receta puede variar.`,
    source: 'Open Food Facts',
  };
}

async function estimateMealNutrition(food, portionGrams) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(food)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,nutriments`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SyncLifeOS/1.0 (nutrition estimates)', Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Open Food Facts respondió ${response.status}.`);
    const data = await response.json();
    const product = (data.products || []).find((item) => item.nutriments);
    const estimate = product && estimateFromOpenFoodFacts(product, portionGrams);
    if (estimate) return estimate;
  } catch (error) {
    console.warn('Open Food Facts no está disponible; se usará la referencia local:', error.message);
  } finally {
    clearTimeout(timeout);
  }

  const reference = findLocalNutritionReference(food);
  if (reference) {
    const multiplier = portionGrams / 100;
    return {
      fiberG: Number((reference.fiberG * multiplier).toFixed(1)),
      sodiumMg: Math.round(reference.sodiumMg * multiplier),
      addedSugarG: Number((reference.addedSugarG * multiplier).toFixed(1)),
      micronutrients: reference.micronutrients.replace(/~([\d.]+)\s*(mg|µg)/g, (match, amount, unit) => (
        `~${Number((Number(amount) * multiplier).toFixed(1))} ${unit}`
      )),
      basis: `Referencia general aproximada por 100 g, ajustada a ${portionGrams} g. Puede variar según el alimento y su preparación.`,
      source: 'Referencia nutricional local',
    };
  }

  return {
    fiberG: null,
    sodiumMg: null,
    addedSugarG: null,
    micronutrients: '',
    basis: 'No se encontraron datos para este alimento. Completa o corrige los nutrientes manualmente; no se inventaron valores.',
    source: 'Sin datos nutricionales',
  };
}

app.post('/api/synclife/ai/nutrition-estimate', async (req, res) => {
  try {
    const food = typeof req.body.food === 'string' ? req.body.food.trim().slice(0, 160) : '';
    const portion = typeof req.body.portion === 'string' ? req.body.portion.trim().slice(0, 100) : '';
    const mealType = typeof req.body.mealType === 'string' ? req.body.mealType : '';
    const validMealTypes = ['Desayuno', 'Almuerzo', 'Cena', 'Break'];
    if (!food || !portion || !validMealTypes.includes(mealType)) {
      return res.status(400).json({ error: 'Indica el alimento, una porción y una categoría válida para estimar sus nutrientes.' });
    }
    const portionGrams = getPortionGrams(portion);
    if (portionGrams === null) {
      return res.status(400).json({ error: 'Indica una cantidad numérica, por ejemplo 200 g o 1 porción (200 g).' });
    }

    const estimate = await estimateMealNutrition(food, portionGrams);
    return res.json({
      ...estimate,
      micronutrients: estimate.micronutrients.slice(0, 120),
      basis: estimate.basis.slice(0, 240),
      estimatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('No se pudo estimar la nutrición:', error.message);
    return res.status(error.status || 500).json({ error: error.message || 'No se pudo estimar la nutrición.' });
  }
});

app.post('/api/synclife/ai/workout-plan', async (req, res) => {
  try {
    const { profile, preference } = req.body;
    const weight = Number(profile?.weight);
    const height = Number(profile?.height);
    const age = Number(profile?.age);
    if (!Number.isFinite(weight) || weight < 1 || weight > 500
      || !Number.isFinite(height) || height < 30 || height > 280
      || !Number.isInteger(age) || age < 13 || age > 120
      || !['femenino', 'masculino', 'otro', 'prefiero no decirlo'].includes(profile?.sex)
      || !['casa', 'gimnasio'].includes(preference)) {
      return res.status(400).json({ error: 'Completa un perfil válido (peso, talla, género y edad) y elige casa o gimnasio.' });
    }
    const { provider } = getAIConfig();
    const response = await generateWithAI(
      `Crea una rutina semanal general, gradual y segura, en español, para una persona de ${age} años, ${profile.sex}, peso ${weight} kg y talla ${height} cm. Preferencia: ${preference}. Usa el perfil solo como contexto; no diagnostiques, no recomiendes adelgazar, y no uses IMC para etiquetar. No hay información sobre enfermedades o lesiones: indica que se debe detener ante dolor y consultar a un profesional si tiene condiciones médicas. Propón 7 días con descanso/recuperación incluido, ejercicios apropiados a ${preference}, nombres claros y duración en minutos (0 si descanso). Responde SOLO este JSON: {"intensity":"...", "home":[{"day":"Lunes","activities":["..."],"duration":20}], "gimnasio":[{"day":"Lunes","activities":["..."],"duration":20}]}. Cada plan debe incluir los 7 días en orden Lunes a Domingo; 2-4 actividades por día activo y al menos un día de descanso.`,
    );
    const weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    const validPlan = (plan) => Array.isArray(plan) && plan.length === 7
      && plan.every((day, index) => day.day === weekdays[index]
        && Array.isArray(day.activities) && day.activities.every((activity) => typeof activity === 'string')
        && Number.isFinite(Number(day.duration)) && Number(day.duration) >= 0 && Number(day.duration) <= 180);
    if (typeof response.intensity !== 'string' || !validPlan(response.home) || !validPlan(response.gimnasio)) {
      return res.status(502).json({ error: 'La IA no devolvió el formato esperado para la rutina.' });
    }
    return res.json({ ...response, provider: provider === 'gemini' ? 'Gemini' : 'OpenAI', bmiContext: false });
  } catch (error) {
    console.error('No se pudo generar la rutina con IA:', error.message);
    return res.status(error.status || 500).json({ error: error.message || 'No se pudo generar la rutina.' });
  }
});

app.post('/api/synclife/sync', async (req, res) => {
  try {
    const { 
      ciudad = "Cusco", 
      montoUSD = 10, 
      comidaDetalle = "Avena", 
      costoComidaPEN = 8.50, 
      animoValor = 8, 
      horasEnfoque = 4, 
      actividadNombre = "Estudio", 
      ejercicioCliente = "30 min Cardio", 
      ejercitado = true 
    } = req.body;

    const [clima, finanzas, nutricion] = await Promise.all([
      obtenerClima(ciudad),
      convertirMoneda(montoUSD),
      analizarNutricion(comidaDetalle)
    ]);

    const diagnostico = generarDiagnostico({
      horasEnfoque: parseFloat(horasEnfoque),
      animoValor: parseInt(animoValor),
      esAhorro: finanzas.esAhorro,
      ejercitado
    });

    // Guardar en la base de datos SQLite
    await guardarRegistroDB({
      actividadNombre,
      horasEnfoque,
      comidaDetalle,
      costoComidaPEN,
      montoUSD,
      gastoPEN: finanzas.gastoPEN,
      ejercicioCliente,
      ejercitado,
      animoValor,
      ciudad,
      score: diagnostico.score
    });

    res.json({ clima, finanzas, nutricion, diagnostico, actividadNombre, ejercicioCliente, costoComidaPEN });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en la persistencia del backend" });
  }
});

const frontendDist = path.resolve(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

const port = Number(process.env.PORT) || 3002;
app.listen(port, () => {
  console.log(`🚀 Server SyncLife con SQLite en http://localhost:${port}`);
  try {
    const config = getAIConfig();
    console.log(`IA: ${config.provider} ${config.apiKey ? 'configurada' : 'sin clave'} (${config.model})`);
  } catch (error) {
    console.error(`IA: configuración inválida. ${error.message}`);
  }
});