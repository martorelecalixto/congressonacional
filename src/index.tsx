import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
//import { serveStatic } from 'hono/cloudflare-workers'
import { XMLParser } from 'fast-xml-parser'

type Bindings = {
  __STATIC_CONTENT_MANIFEST: unknown
}

const app = new Hono<{ Bindings: Bindings }>()

/* --------------------------------- Config --------------------------------- */

const CAMARA = 'https://dadosabertos.camara.leg.br/api/v2'
const SENADO = 'https://legis.senado.leg.br/dadosabertos'
const SENADO_ADM = 'https://adm.senado.gov.br/adm-dadosabertos/api/v1'

const asArray = <T,>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => ['Parlamentar', 'Materia', 'Autuacao'].includes(name)
})

/* ------------------- fetch com cache em memória + retry ------------------- */

type CacheEntry = { expires: number; data: unknown }
const memCache = new Map<string, CacheEntry>()

/* Respostas grandes (ex.: CEAPS anual, vários MB) podem estourar a memória
 * do Worker se muitas forem cacheadas juntas: ao cachear uma entrada grande,
 * as demais são removidas. */
const CACHE_LIMITE_ENTRADAS = 250
const CACHE_TAMANHO_GRANDE = 3_000_000 // caracteres do texto JSON

function cacheGet(key: string) {
  const hit = memCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data
  if (hit) memCache.delete(key)
  return undefined
}

function cacheSet(key: string, data: unknown, ttlMs: number, tamanho = 0) {
  if (tamanho > CACHE_TAMANHO_GRANDE) {
    memCache.clear()
  } else if (memCache.size >= CACHE_LIMITE_ENTRADAS) {
    const now = Date.now()
    for (const [k, v] of memCache) {
      if (v.expires <= now) memCache.delete(k)
    }
    // Ainda cheio? Remove a entrada mais antiga (Map preserva ordem de inserção)
    const maisAntiga = memCache.keys().next().value
    if (maisAntiga !== undefined && memCache.size >= CACHE_LIMITE_ENTRADAS) {
      memCache.delete(maisAntiga)
    }
  }
  memCache.set(key, { expires: Date.now() + ttlMs, data })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Jitter de ±50% evita rajadas sincronizadas de retry (pioram o 429). */
const jitter = (ms: number) => Math.floor(ms * (0.5 + Math.random()))

class UpstreamError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

/**
 * fetch com retry/backoff:
 *  - respeita o cabeçalho Retry-After do 429 (limitado a 8s);
 *  - timeout explícito por tentativa (AbortSignal.timeout);
 *  - backoff exponencial com jitter.
 */
async function fetchResposta(
  url: string,
  opts: { accept?: string; timeoutMs?: number; retries?: number } = {}
): Promise<Response> {
  const { accept = 'application/json', timeoutMs = 20_000, retries = 3 } = opts
  let lastErr: unknown = null

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': 'portal-legislativo/4.2 (educacional; dados abertos)'
        },
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'))
        lastErr = new UpstreamError(
          `API oficial indisponível no momento (HTTP ${res.status})`,
          res.status
        )
        if (attempt < retries - 1) {
          const espera = res.status === 429 && retryAfter > 0
            ? Math.min(retryAfter * 1000, 20_000)
            : 900 * (attempt + 1)
          await sleep(jitter(espera))
        }
        continue
      }

      if (!res.ok) throw new UpstreamError(`Upstream retornou HTTP ${res.status}`, res.status)
      return res
    } catch (err) {
      lastErr = err
      // 4xx de verdade não adianta tentar de novo
      if (err instanceof UpstreamError && err.status !== 429 && err.status < 500) throw err
      if (attempt < retries - 1) await sleep(jitter(800 * (attempt + 1)))
    }
  }

  throw lastErr instanceof Error ? lastErr : new UpstreamError(String(lastErr))
}

async function fetchJson(
  url: string,
  opts: { ttl?: number; retries?: number; timeoutMs?: number } = {}
) {
  const { ttl = 5 * 60_000, retries = 3, timeoutMs = 20_000 } = opts
  const cached = cacheGet(url)
  if (cached !== undefined) return cached

  const res = await fetchResposta(url, { accept: 'application/json', timeoutMs, retries })
  const text = await res.text()

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    // A Câmara devolve XML se o Accept for ignorado — erro claro em vez de
    // "Unexpected token <".
    throw new UpstreamError('Upstream devolveu conteúdo inválido (esperava JSON)', 502)
  }

  cacheSet(url, data, ttl, text.length)
  return data
}

async function fetchText(url: string, timeoutMs = 25_000) {
  const res = await fetchResposta(url, {
    accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
    timeoutMs
  })
  return res.text()
}

const clampItens = (v: string | undefined, padrao: number): number =>
  Math.min(100, Math.max(1, Number(v) || padrao))

/** Validadores de parâmetros de data usados nas rotas de despesas. */
const anoValido = (v: string | undefined): boolean => !v || /^\d{4}$/.test(v)
const mesValido = (v: string | undefined): boolean =>
  !v || (Number(v) >= 1 && Number(v) <= 12 && /^\d{1,2}$/.test(v))

function apiError(c: any, err: unknown, msg: string) {
  console.error(msg, err)
  const detalhe = err instanceof Error ? err.message : String(err)
  const status = err instanceof UpstreamError ? err.status : 502

  // CORREÇÃO: 429 (rate limit do upstream) vira 429 nosso também — assim o
  // front pode diferenciar "API oficial ocupada" de "servidor quebrado" e
  // orientar o usuário a tentar novamente.
  if (status === 429) {
    return c.json(
      {
        error: 'A API oficial está limitando as requisições no momento. Aguarde alguns segundos e tente novamente.',
        detalhe,
        retryAfterSeconds: 15
      },
      429
    )
  }

  // 404 vira 404 (ex.: código de deputado inexistente) em vez de 502 genérico
  const http = status === 404 ? 404 : status === 400 ? 400 : 502
  const amigavel = status === 404 ? `${msg} — registro não encontrado na API oficial.` : msg
  return c.json({ error: amigavel, detalhe }, http)
}

/* ---------------------- CEAP anual da Câmara dos Deputados ------------------ */

/*
 * A API REST /deputados/{id}/despesas pode retornar x-total-count=0 mesmo
 * quando o registro existe no arquivo oficial anual da Cota Parlamentar.
 *
 * Para CEAP, a Câmara disponibiliza os arquivos anuais em JSON+ZIP.
 * Ex.: Ano-2025.json.zip
 *
 * O Worker NÃO descompacta o ZIP inteiro em memória. Primeiro localiza no ZIP
 * o arquivo Ano-{ano}.json e depois usa DecompressionStream('deflate-raw')
 * para ler somente o conteúdo JSON em streaming.
 *
 * Isso evita o erro anterior (HTTP 404), que ocorreu porque tentamos acessar
 * Ano-{ano}.json diretamente. A documentação oficial informa que JSON, XML e
 * CSV são disponibilizados comprimidos em ZIP.
 */

const CEAP_URL = (ano: string) =>
  `https://www.camara.leg.br/cotas/Ano-${encodeURIComponent(ano)}.json.zip`

const CEAP_MAX_FALLBACK_ZIP = 30 * 1024 * 1024
const CEAP_ZIP_TAIL = 65_557
const CEAP_JSON_ENTRY = (ano: string) => `Ano-${ano}.json`

type CeapDespesa = {
  nomeParlamentar?: string
  cpf?: string
  idDeputado?: number | string
  numeroCarteiraParlamentar?: string
  legislatura?: number | string
  siglaUF?: string
  siglaPartido?: string
  codigoLegislatura?: number | string
  numeroSubCota?: number | string
  descricao?: string
  numeroEspecificacaoSubCota?: number | string
  descricaoEspecificacao?: string
  fornecedor?: string
  cnpjCPF?: string
  numero?: string
  tipoDocumento?: string
  dataEmissao?: string
  valorDocumento?: number | string
  valorGlosa?: number | string
  valorLiquido?: number | string
  mes?: number | string
  ano?: number | string
  parcela?: number | string
  passageiro?: string
  trecho?: string
  lote?: string
  ressarcimento?: string
  datPagamentoRestituicao?: string
  restituicao?: string
  numeroDeputadoID?: number | string
  idDocumento?: number | string
  urlDocumento?: string
  [key: string]: unknown
}

const lerU16 = (b: Uint8Array, p: number) =>
  b[p] | (b[p + 1] << 8)

const lerU32 = (b: Uint8Array, p: number) =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0

function localizarFimCentral(zip: Uint8Array): number {
  const inicio = Math.max(0, zip.length - CEAP_ZIP_TAIL)

  for (let p = zip.length - 22; p >= inicio; p--) {
    if (lerU32(zip, p) === 0x06054b50) return p
  }

  throw new UpstreamError('CEAP: final do arquivo ZIP não foi localizado.', 502)
}

type CeapZipEntry = {
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
  fileNameLength: number
  extraLength: number
}

function localizarEntradaCeap(zip: Uint8Array, ano: string): CeapZipEntry {
  const eocd = localizarFimCentral(zip)
  const centralSize = lerU32(zip, eocd + 12)
  const centralOffset = lerU32(zip, eocd + 16)
  const nomeEsperado = CEAP_JSON_ENTRY(ano)
  const decoder = new TextDecoder('utf-8')

  let p = centralOffset
  const fim = centralOffset + centralSize

  while (p + 46 <= fim && p + 46 <= zip.length) {
    if (lerU32(zip, p) !== 0x02014b50) break

    const compressionMethod = lerU16(zip, p + 10)
    const compressedSize = lerU32(zip, p + 20)
    const uncompressedSize = lerU32(zip, p + 24)
    const fileNameLength = lerU16(zip, p + 28)
    const extraLength = lerU16(zip, p + 30)
    const commentLength = lerU16(zip, p + 32)
    const localHeaderOffset = lerU32(zip, p + 42)

    const nomeInicio = p + 46
    const nomeFim = nomeInicio + fileNameLength
    const nome = decoder.decode(zip.subarray(nomeInicio, nomeFim))

    if (nome === nomeEsperado || nome.endsWith(`/${nomeEsperado}`)) {
      return {
        compressedSize,
        uncompressedSize,
        compressionMethod,
        localHeaderOffset,
        fileNameLength,
        extraLength
      }
    }

    p = nomeFim + extraLength + commentLength
  }

  throw new UpstreamError(`CEAP: entrada ${nomeEsperado} não encontrada no ZIP.`, 502)
}

async function buscarBytesZip(
  url: string,
  inicio: number,
  fim: number
): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      Range: `bytes=${inicio}-${fim}`,
      Accept: 'application/octet-stream',
      'User-Agent': 'portal-legislativo/4.3-CEAP (educacional; dados abertos)'
    },
    signal: AbortSignal.timeout(120_000)
  })

  if (res.status !== 206) {
    throw new UpstreamError(`CEAP: servidor não aceitou Range (HTTP ${res.status}).`, 502)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  const esperado = fim - inicio + 1
  if (bytes.length !== esperado) {
    throw new UpstreamError(
      `CEAP: Range incompleto (${bytes.length} bytes; esperado ${esperado}).`,
      502
    )
  }
  return bytes
}

async function obterEntradaJsonCeap(ano: string): Promise<ReadableStream<Uint8Array>> {
  const url = CEAP_URL(ano)

  // Primeiro tentamos descobrir o tamanho do arquivo para localizar o EOCD
  // sem baixar o ZIP inteiro.
  const head = await fetch(url, {
    method: 'HEAD',
    headers: {
      Accept: 'application/zip,application/octet-stream',
      'User-Agent': 'portal-legislativo/4.3-CEAP (educacional; dados abertos)'
    },
    signal: AbortSignal.timeout(30_000)
  })

  if (!head.ok) {
    throw new UpstreamError(`CEAP: arquivo ${url} retornou HTTP ${head.status}.`, head.status)
  }

  const contentLength = Number(head.headers.get('content-length') || 0)

  let zipCompleto: Uint8Array | null = null

  if (contentLength > 0) {
    if (contentLength <= CEAP_MAX_FALLBACK_ZIP) {
      // Mesmo sendo pequeno o suficiente, preferimos Range. Se o servidor não
      // suportar Range, o GET completo abaixo é um fallback seguro para esse
      // tamanho conhecido.
      try {
        const tailInicio = Math.max(0, contentLength - CEAP_ZIP_TAIL)
        const tail = await buscarBytesZip(url, tailInicio, contentLength - 1)
        const eocdRel = localizarFimCentral(tail)
        const centralSize = lerU32(tail, eocdRel + 12)
        const centralOffset = lerU32(tail, eocdRel + 16)

        const centralFim = centralOffset + centralSize - 1
        const central = await buscarBytesZip(url, centralOffset, centralFim)

        // Reconstitui apenas o trecho necessário para reutilizar o parser do
        // diretório central. O EOCD e o central directory cabem normalmente
        // em poucos MB; não carregamos o JSON descompactado.
        const eocdLocal = new Uint8Array(22)
        eocdLocal.set(tail.subarray(eocdRel, eocdRel + 22))
        const zipMeta = new Uint8Array(Math.max(central.length + 22, 22))
        zipMeta.set(central, 0)

        // Parser especializado para o central directory recebido por Range.
        const nomeEsperado = CEAP_JSON_ENTRY(ano)
        const decoder = new TextDecoder('utf-8')
        let p = 0
        let entry: CeapZipEntry | null = null

        while (p + 46 <= central.length && lerU32(central, p) === 0x02014b50) {
          const method = lerU16(central, p + 10)
          const csize = lerU32(central, p + 20)
          const usize = lerU32(central, p + 24)
          const nlen = lerU16(central, p + 28)
          const xlen = lerU16(central, p + 30)
          const clen = lerU16(central, p + 32)
          const loff = lerU32(central, p + 42)
          const name = decoder.decode(central.subarray(p + 46, p + 46 + nlen))

          if (name === nomeEsperado || name.endsWith(`/${nomeEsperado}`)) {
            entry = {
              compressedSize: csize,
              uncompressedSize: usize,
              compressionMethod: method,
              localHeaderOffset: loff,
              fileNameLength: nlen,
              extraLength: xlen
            }
            break
          }
          p += 46 + nlen + xlen + clen
        }

        if (!entry) {
          throw new UpstreamError(`CEAP: entrada ${nomeEsperado} não encontrada no ZIP.`, 502)
        }

        if (entry.compressionMethod !== 8) {
          throw new UpstreamError(
            `CEAP: método de compressão ZIP não suportado (${entry.compressionMethod}).`,
            502
          )
        }

        const localHeader = await buscarBytesZip(
          url,
          entry.localHeaderOffset,
          entry.localHeaderOffset + 29
        )
        if (lerU32(localHeader, 0) !== 0x04034b50) {
          throw new UpstreamError('CEAP: cabeçalho local do ZIP inválido.', 502)
        }

        const nomeLocal = lerU16(localHeader, 26)
        const extraLocal = lerU16(localHeader, 28)
        const dadosInicio = entry.localHeaderOffset + 30 + nomeLocal + extraLocal
        const dadosFim = dadosInicio + entry.compressedSize - 1

        const compressed = await buscarBytesZip(url, dadosInicio, dadosFim)
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(compressed)
            controller.close()
          }
        })

        //return source.pipeThrough(new DecompressionStream('deflate-raw'))
        const decompressor =
          new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>

        return source.pipeThrough(decompressor)

      } catch (err) {
        // Se o servidor não suporta Range, tentamos o ZIP completo somente
        // quando o arquivo é pequeno o bastante para o limite de segurança.
        if (!(err instanceof UpstreamError) || !String(err.message).includes('não aceitou Range')) {
          throw err
        }
      }
    }

    if (contentLength > CEAP_MAX_FALLBACK_ZIP) {
      throw new UpstreamError(
        `CEAP: ZIP muito grande para o modo fallback (${contentLength} bytes).`,
        502
      )
    }
  }

  const full = await fetchResposta(url, {
    accept: 'application/zip,application/octet-stream',
    timeoutMs: 120_000,
    retries: 2
  })
  const bytes = new Uint8Array(await full.arrayBuffer())
  const entry = localizarEntradaCeap(bytes, ano)

  if (entry.compressionMethod !== 8) {
    throw new UpstreamError(
      `CEAP: método de compressão ZIP não suportado (${entry.compressionMethod}).`,
      502
    )
  }

  const local = entry.localHeaderOffset
  if (lerU32(bytes, local) !== 0x04034b50) {
    throw new UpstreamError('CEAP: cabeçalho local do ZIP inválido.', 502)
  }

  const nomeLocal = lerU16(bytes, local + 26)
  const extraLocal = lerU16(bytes, local + 28)
  const dadosInicio = local + 30 + nomeLocal + extraLocal
  const compressed = bytes.subarray(dadosInicio, dadosInicio + entry.compressedSize)

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed)
      controller.close()
    }
  })

  //return source.pipeThrough(new DecompressionStream('deflate-raw'))
  const decompressor =
    new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>

  return source.pipeThrough(decompressor)  
}

/**
 * Lê o JSON descompactado em streaming no formato:
 * { "dados": [ { ... }, { ... }, ... ] }
 *
 * Mantém em memória somente os registros do deputado consultado.
 */
async function lerCeapStreaming(
  ano: string,
  codigoDeputado: string,
  mes?: string
): Promise<CeapDespesa[]> {
  const stream = await obterEntradaJsonCeap(ano)
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })

  const wantedId = String(codigoDeputado)
  const wantedMes = mes ? Number(mes) : null
  const resultados: CeapDespesa[] = []

  let depth = 0
  let inString = false
  let escaped = false
  let capturando = false
  let objeto = ''

  const processarTexto = (texto: string) => {
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i]

      if (capturando) objeto += ch

      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }

      if (ch === '"') {
        inString = true
        continue
      }

      if (ch === '{') {
        depth++
        if (depth === 2) {
          capturando = true
          objeto = '{'
        }
      } else if (ch === '}') {
        if (depth === 2 && capturando) {
          try {
            const registro = JSON.parse(objeto) as CeapDespesa
            if (String(registro.idDeputado ?? '') === wantedId) {
              const mesRegistro = Number(registro.mes ?? 0)
              if (wantedMes === null || mesRegistro === wantedMes) {
                resultados.push(registro)
              }
            }
          } catch (err) {
            console.warn('CEAP: registro JSON ignorado por erro de parsing', err)
          }
          capturando = false
          objeto = ''
        }
        depth--
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      processarTexto(decoder.decode(value, { stream: true }))

      if (resultados.length > 5000) {
        throw new UpstreamError('Quantidade inesperada de despesas para o deputado.', 502)
      }
    }

    const resto = decoder.decode()
    if (resto) processarTexto(resto)
  } finally {
    reader.releaseLock()
  }

  return resultados
}

function normalizarCeapDespesa(d: CeapDespesa) {
  return {
    id: d.idDocumento ?? null,
    nomeParlamentar: d.nomeParlamentar ?? '',
    cpf: d.cpf ?? '',
    idDeputado: d.idDeputado ?? null,
    numeroCarteiraParlamentar: d.numeroCarteiraParlamentar ?? '',
    legislatura: d.legislatura ?? null,
    siglaUF: d.siglaUF ?? '',
    siglaPartido: d.siglaPartido ?? '',
    codigoLegislatura: d.codigoLegislatura ?? null,
    numeroSubCota: d.numeroSubCota ?? null,
    descricao: d.descricao ?? '',
    numeroEspecificacaoSubCota: d.numeroEspecificacaoSubCota ?? null,
    descricaoEspecificacao: d.descricaoEspecificacao ?? '',
    fornecedor: d.fornecedor ?? '',
    cnpjCPF: d.cnpjCPF ?? '',
    numero: d.numero ?? '',
    tipoDocumento: d.tipoDocumento ?? '',
    dataEmissao: d.dataEmissao ?? '',
    valorDocumento: toNumero(d.valorDocumento),
    valorGlosa: toNumero(d.valorGlosa),
    valorLiquido: toNumero(d.valorLiquido),
    mes: d.mes ?? null,
    ano: d.ano ?? null,
    parcela: d.parcela ?? null,
    passageiro: d.passageiro ?? '',
    trecho: d.trecho ?? '',
    lote: d.lote ?? '',
    ressarcimento: d.ressarcimento ?? '',
    datPagamentoRestituicao: d.datPagamentoRestituicao ?? '',
    restituicao: d.restituicao ?? '',
    numeroDeputadoID: d.numeroDeputadoID ?? null,
    idDocumento: d.idDocumento ?? null,
    urlDocumento: d.urlDocumento ?? ''
  }
}

async function buscarCeapDeputado(
  ano: string,
  codigo: string,
  mes?: string
): Promise<any[]> {
  const chave = `ceap:${ano}:${codigo}:${mes || ''}`
  const cached = cacheGet(chave)
  if (cached !== undefined) return cached as any[]

  const dados = await lerCeapStreaming(ano, codigo, mes)
  const normalizados = dados.map(normalizarCeapDespesa)

  normalizados.sort((a, b) =>
    String(b.dataEmissao || '').localeCompare(String(a.dataEmissao || ''))
  )

  cacheSet(chave, normalizados, 15 * 60_000)
  return normalizados
}

/* ------------------------------ Middleware -------------------------------- */

app.use('/api/*', cors())

//app.use('/static/*', serveStatic({ manifest: (globalThis as any).__STATIC_CONTENT_MANIFEST }))
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/favicon.svg', serveStatic({ root: './public' }))

/* ============================ CÂMARA DOS DEPUTADOS ========================= */

// Lista de deputados — repassa nome, partido, uf, pagina e itens
app.get('/api/camara/deputados', async (c) => {
  try {
    const q = c.req.query()
    const params = new URLSearchParams({ ordem: 'ASC', ordenarPor: 'nome' })
    if (q.nome) params.set('nome', q.nome)
    if (q.partido) params.set('siglaPartido', q.partido.toUpperCase())
    if (q.uf) params.set('siglaUf', q.uf.toUpperCase())
    if (q.pagina) params.set('pagina', q.pagina)
    params.set('itens', String(clampItens(q.itens, 20)))

    return c.json(await fetchJson(`${CAMARA}/deputados?${params}`))
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar deputados')
  }
})

// Detalhe cadastral de um deputado (modal "Detalhes" no front-end)
app.get('/api/camara/deputados/:id', async (c) => {
  try {
    const id = c.req.param('id')
    return c.json(
      await fetchJson(`${CAMARA}/deputados/${encodeURIComponent(id)}`, { ttl: 60 * 60_000 })
    )
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar detalhe do deputado')
  }
})

// Partidos (para autocompletar o campo de partido)
app.get('/api/camara/partidos', async (c) => {
  try {
    const q = c.req.query()
    const params = new URLSearchParams({ ordem: 'ASC', ordenarPor: 'sigla' })
    params.set('itens', String(clampItens(q.itens, 100)))

    return c.json(await fetchJson(`${CAMARA}/partidos?${params}`, { ttl: 60 * 60_000 }))
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar partidos')
  }
})

// Despesas (CEAP) de um deputado — repassa ano, mes, pagina e itens.
// CORREÇÃO (v4.1): validação de ano/mês ANTES de chamar o upstream. Antes,
// valores inválidos eram repassados à API da Câmara, que respondia 400 com
// corpo em XML e o usuário recebia um genérico "conteúdo inválido".
app.get('/api/camara/despesas', async (c) => {
  const codigo = c.req.query('codigo') || ''
  if (!codigo) return c.json({ error: 'Informe o parâmetro "codigo".' }, 400)
  if (!/^\d+$/.test(codigo)) {
    return c.json({ error: 'O "codigo" deve ser numérico (ID do deputado).' }, 400)
  }

  const q = c.req.query()
  if (!anoValido(q.ano)) {
    return c.json({ error: 'Parâmetro "ano" inválido. Use o formato AAAA (ex.: 2024).' }, 400)
  }
  if (!mesValido(q.mes)) {
    return c.json({ error: 'Parâmetro "mes" inválido. Use um número de 1 a 12.' }, 400)
  }

  try {
    /*
     * Para CEAP, o arquivo anual oficial é a fonte de verdade.
     * Se o ano não vier informado, usamos o ano atual para preservar o
     * comportamento esperado pela interface.
     */
    const ano = q.ano || String(new Date().getFullYear())
    const dados = await buscarCeapDeputado(ano, codigo, q.mes)

    const pagina = Math.max(1, Number(q.pagina) || 1)
    const itens = clampItens(q.itens, 15)
    const inicio = (pagina - 1) * itens
    const fim = inicio + itens
    const paginaDados = dados.slice(inicio, fim)
    const total = dados.length
    const ultimaPagina = Math.max(1, Math.ceil(total / itens))

    const links: any[] = []
    const base = new URL(c.req.url)
    const makeUrl = (p: number) => {
      const u = new URL(base)
      u.searchParams.set('codigo', codigo)
      u.searchParams.set('ano', ano)
      if (q.mes) u.searchParams.set('mes', q.mes)
      u.searchParams.set('pagina', String(p))
      u.searchParams.set('itens', String(itens))
      return u.toString()
    }

    if (pagina > 1) links.push({ rel: 'first', href: makeUrl(1) })
    if (pagina > 1) links.push({ rel: 'prev', href: makeUrl(pagina - 1) })
    if (pagina < ultimaPagina) links.push({ rel: 'next', href: makeUrl(pagina + 1) })
    links.push({ rel: 'last', href: makeUrl(ultimaPagina) })

    c.header('Cache-Control', 'public, max-age=300')

    return c.json({
      dados: paginaDados,
      links,
      total,
      pagina,
      itens,
      totalPaginas: ultimaPagina,
      fonte: 'CEAP anual oficial da Câmara dos Deputados',
      ano
    })
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar despesas CEAP')
  }
})

// Resumo agregado das despesas de um deputado (para os gráficos).
// CORREÇÃO (v4.1): limite reduzido para 6 páginas e busca das páginas 2..N
// EM PARALELO. O plano gratuito do Cloudflare Workers permite apenas 6
// sub-requisições por requisição — com 15 páginas sequenciais o endpoint
// inteiro falhava (e era a causa principal da aba CEAP "não funcionar").
// Com Promise.allSettled, uma página que falhar não derruba o resumo: o
// front exibe "(amostra)" quando o resultado é parcial. Inclui agregação
// por tipo, mês e fornecedor.
app.get('/api/camara/despesas/:codigo/resumo', async (c) => {
  const codigo = c.req.param('codigo')
  const ano = c.req.query('ano') || String(new Date().getFullYear())
  const mes = c.req.query('mes') || ''

  if (!/^\d+$/.test(codigo)) {
    return c.json({ error: 'O "codigo" deve ser numérico (ID do deputado).' }, 400)
  }
  if (!anoValido(ano)) {
    return c.json({ error: 'Parâmetro "ano" inválido. Use o formato AAAA (ex.: 2024).' }, 400)
  }
  if (!mesValido(mes)) {
    return c.json({ error: 'Parâmetro "mes" inválido. Use um número de 1 a 12.' }, 400)
  }

  try {
    /*
     * O resumo usa exatamente a mesma fonte e o mesmo conjunto de registros
     * da listagem. Assim, gráfico e tabela não ficam divergentes.
     */
    const dados = await buscarCeapDeputado(ano, codigo, mes)

    let totalGeral = 0
    let totalLiquido = 0
    const porTipo = new Map<string, number>()
    const porMes = new Map<string, number>()
    const porFornecedor = new Map<string, number>()

    for (const d of dados) {
      const valorDocumento = toNumero(d.valorDocumento)
      const valorLiquido = toNumero(d.valorLiquido || d.valorDocumento)

      totalGeral += valorDocumento
      totalLiquido += valorLiquido

      const tipo = d.descricao || 'Não informado'
      porTipo.set(tipo, (porTipo.get(tipo) || 0) + valorLiquido)

      const chaveMes = `${d.ano ?? ano}-${String(d.mes ?? '—').padStart(2, '0')}`
      porMes.set(chaveMes, (porMes.get(chaveMes) || 0) + valorLiquido)

      const fornecedor = d.fornecedor || 'Não informado'
      porFornecedor.set(fornecedor, (porFornecedor.get(fornecedor) || 0) + valorLiquido)
    }

    c.header('Cache-Control', 'public, max-age=300')

    return c.json({
      codigo,
      ano,
      mes: mes || null,
      quantidade: dados.length,
      totalGeral,
      totalLiquido,
      paginasColetadas: 1,
      amostra: false,
      fonte: 'CEAP anual oficial da Câmara dos Deputados',
      porTipo: Array.from(porTipo, ([tipo, total]) => ({ tipo, total }))
        .sort((a, b) => b.total - a.total),
      porMes: Array.from(porMes, ([mesRef, total]) => ({ mes: mesRef, total }))
        .sort((a, b) => a.mes.localeCompare(b.mes)),
      porFornecedor: Array.from(porFornecedor, ([fornecedor, total]) => ({ fornecedor, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
    })
  } catch (err) {
    return apiError(c, err, 'Erro ao gerar resumo de despesas CEAP')
  }
})

// Proposições — repassa ano, termo (keywords), tipo, autor, pagina e itens
app.get('/api/camara/proposicoes', async (c) => {
  try {
    const q = c.req.query()
    const params = new URLSearchParams({
      ano: q.ano || String(new Date().getFullYear()),
      ordem: 'DESC',
      ordenarPor: 'id'
    })
    if (q.termo) params.set('keywords', q.termo)
    if (q.tipo) params.set('siglaTipo', q.tipo.toUpperCase())
    if (q.autor) params.set('idDeputadoAutor', q.autor)
    if (q.pagina) params.set('pagina', q.pagina)
    params.set('itens', String(clampItens(q.itens, 20)))

    return c.json(await fetchJson(`${CAMARA}/proposicoes?${params}`))
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar proposições')
  }
})

// Votações — cache mais longo + retry robusto para conviver com o 429 da API
app.get('/api/camara/votacoes', async (c) => {
  try {
    const q = c.req.query()
    const params = new URLSearchParams({
      ordem: 'DESC',
      ordenarPor: 'dataHoraRegistro'
    })

    if (q.pagina) params.set('pagina', q.pagina)
    params.set('itens', String(clampItens(q.itens, 50)))
    
    /*
    const params = new URLSearchParams({
      ano: q.ano || String(new Date().getFullYear()),
      ordem: 'DESC',
      ordenarPor: 'dataHoraRegistro'
    })
    if (q.pagina) params.set('pagina', q.pagina)
    params.set('itens', String(clampItens(q.itens, 50)))
    */

    return c.json(await fetchJson(`${CAMARA}/votacoes?${params}`, {
      ttl: 10 * 60_000,
      retries: 4
    }))
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar votações')
  }
})

// Votos individuais de uma votação (paginado server-side, 100 por vez).
app.get('/api/camara/votacoes/:id/votos', async (c) => {
  const id = c.req.param('id')

  try {
    const data: any = await fetchJson(
      `${CAMARA}/votacoes/${encodeURIComponent(id)}/votos`,
      {
        retries: 4
      }
    )

    const votos = asArray(data.dados).map((v: any) => ({
      nome: v.deputado_?.nome,
      partido: v.deputado_?.siglaPartido,
      uf: v.deputado_?.siglaUf,
      voto: v.tipoVoto,
      urlFoto: v.deputado_?.urlFoto
    }))

    return c.json({
      id,
      total: votos.length,
      dados: votos
    })
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar votos da votação')
  }
})
/*
app.get('/api/camara/votacoes/:id/votos', async (c) => {
  const id = c.req.param('id')
  try {
    const votos: any[] = []
    let pagina = 1
    let ultima = Infinity
    const MAX_PAGINAS = 10

    while (pagina <= ultima && pagina <= MAX_PAGINAS) {
      const data: any = await fetchJson(
        `${CAMARA}/votacoes/${encodeURIComponent(id)}/votos?itens=100&ordem=ASC&ordenarPor=nome&pagina=${pagina}`,
        { retries: 4 }
      )
      const batch = asArray(data.dados)
      votos.push(
        ...batch.map((v: any) => ({
          nome: v.deputado_?.nome,
          partido: v.deputado_?.siglaPartido,
          uf: v.deputado_?.siglaUf,
          voto: v.tipoVoto,
          urlFoto: v.deputado_?.urlFoto
        }))
      )

      const last = asArray(data.links).find((l: any) => l.rel === 'last')
      if (last) {
        try {
          const p = Number(new URL(last.href).searchParams.get('pagina'))
          ultima = Number.isFinite(p) && p > 0 ? p : pagina
        } catch { ultima = pagina }
      } else {
        ultima = pagina
      }

      if (!batch.length) break
      pagina++
    }

    return c.json({ id: Number(id), total: votos.length, dados: votos })
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar votos da votação')
  }
})
*/

/* ============================== SENADO FEDERAL ============================= */

// Senadores em exercício — converte JSON -> formato plano (funciona com 1 ou N registros)
app.get('/api/senado/senadores', async (c) => {
  try {
    const uf = (c.req.query('uf') || '').toUpperCase()
    const partido = (c.req.query('partido') || '').toUpperCase()

    let url = `${SENADO}/senador/lista/atual.json`
    if (uf) url += `?uf=${encodeURIComponent(uf)}`

    const data: any = await fetchJson(url, { ttl: 30 * 60_000 })

    const parlamentares = asArray(
      data?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar
    )

    let senadores = parlamentares.map((p: any) => {
      const id = p.IdentificacaoParlamentar ?? {}
      return {
        codigo: id.CodigoParlamentar,
        nome: id.NomeParlamentar,
        nomeCompleto: id.NomeCompletoParlamentar,
        sexo: id.SexoParlamentar,
        partido: id.SiglaPartidoParlamentar,
        uf: id.UfParlamentar,
        foto: id.UrlFotoParlamentar,
        email: id.EmailParlamentar,
        pagina: id.UrlPaginaParlamentar
      }
    })

    if (partido) senadores = senadores.filter((s: any) => (s.partido || '') === partido)

    return c.json({ total: senadores.length, senadores })
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar senadores')
  }
})

// Matérias do Senado (timeout de 30s + retries + fallback XML)
// Matérias do Senado — novo serviço /processo
// O serviço antigo /materia/pesquisa/lista foi desativado pelo Senado em 01/02/2026.
app.get('/api/senado/materias', async (c) => {
  try {
    const ano = c.req.query('ano') || String(new Date().getFullYear())
    const tipo = (c.req.query('tipo') || 'PLS').toUpperCase()

    // O novo serviço do Senado não utiliza mais as antigas
    // siglas PLS, PEC, PRS etc. como filtro.
    // Fazemos a correspondência aqui para manter a interface atual.
    const tiposDocumento: Record<string, string> = {
      PLS: 'Projeto de Lei Ordinária',
      PL: 'Projeto de Lei Ordinária',
      PLP: 'Projeto de Lei Complementar',
      PEC: 'Proposta de Emenda à Constituição',
      PRS: 'Projeto de Resolução',
    }

    const tipoDocumentoEsperado = tiposDocumento[tipo]

    // Novo serviço oficial do Senado
    const data: any = await fetchJson(
      `${SENADO}/processo?ano=${encodeURIComponent(ano)}`,
      {
        ttl: 10 * 60_000,
        retries: 3,
        timeoutMs: 60_000
      }
    )

    // O novo endpoint retorna diretamente um array
    const lista = asArray<any>(data)

    const materias = lista
      .filter((m: any) => {
        if (!tipoDocumentoEsperado) {
          return true
        }

        return String(m?.tipoDocumento ?? '').trim() === tipoDocumentoEsperado
      })
      .map((m: any) => {
        const identificacao = String(
          m?.identificacao ?? ''
        ).trim()

        // Exemplos:
        // PL 1614/2026
        // PRS 4/2026
        // REQ 44/2026 - CAE
        const match = identificacao.match(
          /^([A-Z0-9]+)\s+(\d+)\/(\d{4})/i
        )

        const sigla = match?.[1]?.toUpperCase() ?? ''
        const numero = match?.[2] ?? ''
        const anoMateria = match?.[3] ?? String(ano)

        return {
          codigo: String(
            m?.codigoMateria ??
            m?.id ??
            ''
          ),

          sigla,

          numero,

          ano: anoMateria,

          ementa: String(
            m?.ementa ??
            ''
          ),

          dataApresent: String(
            m?.dataApresentacao ??
            ''
          ),

          situacao: String(
            m?.situacaoAtual ??
            ''
          ),

          urlDetalhe: String(
            m?.urlDocumento ??
            ''
          ),

          autoria: String(
            m?.autoria ??
            ''
          ),

          tipoDocumento: String(
            m?.tipoDocumento ??
            ''
          ),

          tramitando: String(
            m?.tramitando ??
            ''
          ),
        }
      })
      .filter((m: any) => {
        return m.codigo || m.numero
      })

    return c.json({
      total: materias.length,
      materias,
      fonte: 'https://legis.senado.leg.br/dadosabertos/processo',
      ano,
      tipo,
    })

  } catch (err) {
    return apiError(
      c,
      err,
      'Erro ao buscar matérias'
    )
  }
})

/*Codigo original
app.get('/api/senado/materias', async (c) => {
  try {
    const ano = c.req.query('ano') || String(new Date().getFullYear())
    const tipo = (c.req.query('tipo') || 'PLS').toUpperCase()

    let lista: any[] = []

    try {
      const data: any = await fetchJson(
        `${SENADO}/materia/pesquisa/lista.json?sigla=${encodeURIComponent(tipo)}&ano=${encodeURIComponent(ano)}`,
        { ttl: 10 * 60_000, retries: 3, timeoutMs: 30_000 }
      )
      lista = asArray(
        data?.PesquisaBasicaMateria?.Materias?.Materia ??
        data?.Materias?.Materia
      )
    } catch (jsonErr) {
      console.warn('materias: fallback para XML', jsonErr)
      const xml = await fetchText(
        `${SENADO}/materia/pesquisa/lista?sigla=${encodeURIComponent(tipo)}&ano=${encodeURIComponent(ano)}`,
        30_000
      )
      const json = xmlParser.parse(xml)
      lista = asArray(json?.PesquisaBasicaMateria?.Materias?.Materia)
    }

    const materias = lista.map((m: any) => {
      const ident = m.IdentificacaoMateria ?? {}
      const basicos = m.DadosBasicosMateria ?? {}
      const autuacoes = asArray(m.SituacaoAtual?.Autuacoes?.Autuacao)
      const situacao = autuacoes[0]?.Situacao?.DescricaoSituacao ?? ''

      return {
        codigo: String(ident.CodigoMateria ?? ''),
        sigla: ident.SiglaSubtipoMateria ?? '',
        numero: String(ident.NumeroMateria ?? ''),
        ano: String(ident.AnoMateria ?? ''),
        ementa: basicos.EmentaMateria ?? '',
        dataApresent: basicos.DataApresentacao ?? '',
        situacao: String(situacao),
        urlDetalhe: m['@_UrlDetalheMateria'] ?? m.UrlDetalheMateria ?? ''
      }
    }).filter((m: any) => m.codigo || m.numero)

    return c.json({ total: materias.length, materias })
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar matérias')
  }
})
*/




// Detalhe de uma matéria do Senado
app.get('/api/senado/materias/:codigo', async (c) => {
  const codigo = c.req.param('codigo')
  try {
    const data: any = await fetchJson(
      `${SENADO}/materia/${encodeURIComponent(codigo)}.json`,
      { ttl: 30 * 60_000, timeoutMs: 30_000 }
    )
    return c.json(data)
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar detalhe da matéria')
  }
})

/* --------------------- Despesas (CEAPS) dos Senadores --------------------- */

// Converte valor monetário que pode vir como número ou string "1.234,56"
function toNumero(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (v === undefined || v === null) return 0
  const s = String(v).trim().replace(/[^\d,.-]/g, '')
  if (!s) return 0
  const normalizado = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
  const n = Number(normalizado)
  return Number.isFinite(n) ? n : 0
}

function pickField(r: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = r?.[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
  }
  return ''
}

// Despesas da CEAPS dos senadores — fonte oficial
// https://adm.senado.gov.br/adm-dadosabertos/api/v1/senadores/despesas_ceaps/{ano}
// A API devolve os campos em MAIÚSCULAS (SENADOR, TIPO_DESPESA etc.) e em
// minúsculas dependendo do endpoint — ambos os formatos são aceitos.
app.get('/api/senado/despesas', async (c) => {
  const ano = c.req.query('ano') || String(new Date().getFullYear())
  const senadorQ = (c.req.query('senador') || '').trim()
  const mesQ = (c.req.query('mes') || '').trim()

  if (!/^\d{4}$/.test(ano)) {
    return c.json({ error: 'Parâmetro "ano" inválido. Use AAAA.' }, 400)
  }

  try {
    const data: any = await fetchJson(
      `${SENADO_ADM}/senadores/despesas_ceaps/${encodeURIComponent(ano)}`,
      { ttl: 30 * 60_000, retries: 2, timeoutMs: 60_000 }
    )

    const rows = asArray(
      data?.despesas ??
      data?.dados ??
      data?.data ??
      data?.itens ??
      (Array.isArray(data) ? data : [])
    )

    const normalizadas = rows.map((r: any) => ({
      ano: pickField(r, 'ano', 'ANO'),
      mes: pickField(r, 'mes', 'MES'),
      senador: pickField(r, 'senador', 'SENADOR', 'nome_parlamentar', 'NOME_PARLAMENTAR',
                         'nomeSenador', 'parlamentar', 'nome', 'NOME'),
      tipo: pickField(r, 'tipo_despesa', 'TIPO_DESPESA', 'tipoDespesa', 'tipo', 'TIPO',
                      'rubrica', 'RUBRICA'),
      cnpjCpf: pickField(r, 'cnpj_cpf', 'CNPJ_CPF', 'cnpjCpf', 'cnpjCpfFornecedor',
                         'documento_fornecedor', 'DOCUMENTO_FORNECEDOR', 'cnpj', 'CNPJ'),
      fornecedor: pickField(r, 'fornecedor', 'FORNECEDOR', 'nome_fornecedor', 'NOME_FORNECEDOR',
                            'nomeFornecedor', 'favorecido', 'FAVORECIDO'),
      documento: pickField(r, 'documento', 'DOCUMENTO', 'num_documento', 'NUM_DOCUMENTO',
                           'numDocumento', 'numero_documento'),
      data: pickField(r, 'data', 'DATA', 'data_documento', 'DATA_DOCUMENTO',
                      'dataDocumento', 'data_referencia'),
      valor: toNumero(
        r?.valor_reembolsado ?? r?.VALOR_REEMBOLSADO ?? r?.valorReembolsado ??
        r?.valor ?? r?.VALOR
      )
    })).filter((r) => r.senador !== '' || r.valor > 0)

    const normQ = senadorQ.toLowerCase()
    const filtradas = normalizadas.filter((r) => {
      if (normQ && !r.senador.toLowerCase().includes(normQ)) return false
      if (mesQ && String(Number(r.mes)) !== String(Number(mesQ))) return false
      return true
    })

    let total = 0
    const porTipo = new Map<string, number>()
    const porMes = new Map<string, number>()
    const porSenador = new Map<string, number>()

    for (const r of filtradas) {
      total += r.valor
      const tipo = r.tipo || 'Não informado'
      porTipo.set(tipo, (porTipo.get(tipo) || 0) + r.valor)
      const chaveMes = `${r.ano || ano}-${String(r.mes || '—').padStart(2, '0')}`
      porMes.set(chaveMes, (porMes.get(chaveMes) || 0) + r.valor)
      if (r.senador) porSenador.set(r.senador, (porSenador.get(r.senador) || 0) + r.valor)
    }

    const despesas = senadorQ
      ? filtradas
          .sort((a, b) => b.valor - a.valor)
          .slice(0, 2000)
      : []

    return c.json({
      ano,
      senador: senadorQ || null,
      mes: mesQ || null,
      quantidade: filtradas.length,
      total,
      porTipo: Array.from(porTipo, ([tipo, valor]) => ({ tipo, valor }))
        .sort((a, b) => b.valor - a.valor),
      porMes: Array.from(porMes, ([mesRef, valor]) => ({ mes: mesRef, valor }))
        .sort((a, b) => a.mes.localeCompare(b.mes)),
      porSenador: Array.from(porSenador, ([senador, valor]) => ({ senador, valor }))
        .sort((a, b) => b.valor - a.valor)
        .slice(0, 20),
      despesas
    })
  } catch (err) {
    return apiError(c, err, 'Erro ao buscar despesas (CEAPS) dos senadores')
  }
})

/* ------------------------------- Diagnóstico ------------------------------ */

// Saúde da API: confirma se o Worker está no ar e mostra o estado do cache.
// Acesse /api/health para testar rapidamente se o problema é de deploy.
app.get('/api/health', (c) =>
  c.json({ ok: true, versao: '4.3-CEAP', cacheEntradas: memCache.size, agora: new Date().toISOString() })
)

/* ================================= Página ================================== */

app.get('/', (c) => c.html(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="icon" type="image/svg+xml" href="/favicon.svg">
        <title>Portal Legislativo Brasileiro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
        <style>
            .result-item { transition: all .2s ease; border-left: 4px solid transparent; }
            .result-item:hover { border-left-color: #2563eb; box-shadow: 0 4px 14px rgba(0,0,0,.07); }
            .loading { display: none; }
            .loading.active { display: block; }
            .tab-button { transition: color .15s ease, border-color .15s ease; white-space: nowrap; }
            .chart-box { position: relative; height: 280px; }
            /* Toasts */
            #toast-wrap { position: fixed; bottom: 1rem; right: 1rem; z-index: 60; display: flex; flex-direction: column; gap: .5rem; }
            .toast-item { animation: toast-in .25s ease; }
            .toast-item.toast-out { opacity: 0; transform: translateX(10px); transition: all .3s ease; }
            @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        </style>
    </head>
    <body class="bg-slate-50 text-gray-800">

        <div id="toast-wrap"></div>

        <!-- Header -->
        <header class="sticky top-0 z-40 bg-gradient-to-r from-slate-900 via-blue-900 to-slate-900 text-white shadow-lg">
            <div class="container mx-auto px-4 py-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 class="text-2xl md:text-3xl font-bold">
                        <i class="fas fa-landmark mr-3 text-amber-400"></i>Portal Legislativo Brasileiro
                    </h1>
                    <p class="mt-1 text-sm text-blue-200">Câmara dos Deputados + Senado Federal — gráficos, paginação, filtros e exportação CSV</p>
                </div>
                <div class="flex gap-2 text-xs">
                    <span class="bg-blue-600/40 border border-blue-400/40 rounded-full px-3 py-1"><i class="fas fa-users mr-1"></i>513 deputados</span>
                    <span class="bg-emerald-600/40 border border-emerald-400/40 rounded-full px-3 py-1"><i class="fas fa-user-tie mr-1"></i>81 senadores</span>
                </div>
            </div>
        </header>

        <main class="container mx-auto px-4 py-8">
            <div class="bg-white rounded-xl shadow-md mb-6 overflow-hidden">
                <!-- Tabs -->
                <div class="border-b border-gray-200 px-2 overflow-x-auto">
                    <nav class="flex">
                        <button onclick="changeTab('camara-deputados')" id="tab-camara-deputados" class="tab-button px-5 py-4 text-sm font-medium border-b-2 border-blue-500 text-blue-600">
                            <i class="fas fa-users mr-2"></i>Deputados
                        </button>
                        <button onclick="changeTab('camara-despesas')" id="tab-camara-despesas" class="tab-button px-5 py-4 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-blue-600">
                            <i class="fas fa-receipt mr-2"></i>Despesas (CEAP)
                        </button>
                        <button onclick="changeTab('camara-proposicoes')" id="tab-camara-proposicoes" class="tab-button px-5 py-4 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-blue-600">
                            <i class="fas fa-file-alt mr-2"></i>Proposições
                        </button>
                        <button onclick="changeTab('camara-votacoes')" id="tab-camara-votacoes" class="tab-button px-5 py-4 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-blue-600">
                            <i class="fas fa-vote-yea mr-2"></i>Votações
                        </button>
                        <button onclick="changeTab('senado-senadores')" id="tab-senado-senadores" class="tab-button px-5 py-4 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-emerald-600">
                            <i class="fas fa-user-tie mr-2"></i>Senadores
                        </button>
                        <button onclick="changeTab('senado-materias')" id="tab-senado-materias" class="tab-button px-5 py-4 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-emerald-600">
                            <i class="fas fa-gavel mr-2"></i>Matérias
                        </button>
                        <button onclick="changeTab('senado-despesas')" id="tab-senado-despesas" class="tab-button px-5 py-4 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-emerald-600">
                            <i class="fas fa-coins mr-2"></i>Despesas Senado (CEAPS)
                        </button>
                    </nav>
                </div>

                <div class="p-6">

                    <!-- Deputados -->
                    <div id="content-camara-deputados" class="tab-content">
                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6">
                            <h2 class="text-xl font-bold mb-4"><i class="fas fa-users mr-2 text-blue-600"></i>Buscar Deputados</h2>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Nome</label>
                                    <input type="text" id="deputado-nome" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="Digite o nome">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Partido</label>
                                    <input type="text" id="deputado-partido" list="lista-partidos" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="Ex: PT, PSDB">
                                    <datalist id="lista-partidos"></datalist>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">UF</label>
                                    <input type="text" id="deputado-uf" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="Ex: SP, RJ" maxlength="2">
                                </div>
                            </div>
                            <button onclick="buscarDeputados()" class="mt-4 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">
                                <i class="fas fa-search mr-2"></i>Buscar
                            </button>
                        </div>
                        <div id="chart-deputados-wrap" class="hidden mb-6 bg-white p-4 rounded-xl border border-gray-200">
                            <h3 class="font-semibold text-gray-800 mb-2">Deputados por partido (top 10)</h3>
                            <div class="chart-box"><canvas id="chart-deputados"></canvas></div>
                        </div>
                        <div id="loading-deputados" class="loading text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i>
                            <p class="mt-2 text-gray-600">Carregando...</p>
                        </div>
                        <div id="results-deputados" class="space-y-3"></div>
                    </div>

                    <!-- Despesas Câmara (CEAP) -->
                    <div id="content-camara-despesas" class="tab-content hidden">
                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6 md:sticky md:top-[84px] z-20 shadow-sm">
                            <h2 class="text-xl font-bold mb-1"><i class="fas fa-receipt mr-2 text-blue-600"></i>Despesas de Gabinete (CEAP)</h2>
                            <p class="text-sm text-gray-500 mb-4">Dica: use o botão "Despesas" no card de um deputado para preencher o código automaticamente. Trocar o ano ou o mês re-busca automaticamente.</p>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Código do deputado (ID)</label>
                                    <input type="text" id="deputado-codigo" inputmode="numeric" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="Ex.: 204379">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Ano</label>
                                    <select id="despesa-ano" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"></select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Mês</label>
                                    <select id="despesa-mes" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                                        <option value="">Todos</option>
                                        <option value="1">Janeiro</option><option value="2">Fevereiro</option><option value="3">Março</option>
                                        <option value="4">Abril</option><option value="5">Maio</option><option value="6">Junho</option>
                                        <option value="7">Julho</option><option value="8">Agosto</option><option value="9">Setembro</option>
                                        <option value="10">Outubro</option><option value="11">Novembro</option><option value="12">Dezembro</option>
                                    </select>
                                </div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Filtrar resultados</label>
                                    <input type="text" id="despesa-filtro" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="Fornecedor, tipo, nº documento...">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Ordenar por</label>
                                    <select id="despesa-ordenar" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                                        <option value="data_desc">Mais recentes</option>
                                        <option value="valor_desc">Maior valor</option>
                                        <option value="valor_asc">Menor valor</option>
                                        <option value="fornecedor">Fornecedor (A-Z)</option>
                                    </select>
                                </div>
                            </div>
                            <button onclick="buscarDespesasDeputados(1)" class="mt-4 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">
                                <i class="fas fa-search mr-2"></i>Buscar Despesas
                            </button>
                            <!-- NOVO v4.1: histórico local de buscas (chips) -->
                            <div id="ceap-recentes"></div>
                        </div>
                        <div id="chart-despesas-wrap" class="hidden mb-6 bg-white p-4 rounded-xl border border-gray-200">
                            <h3 class="font-semibold text-gray-800 mb-2">Despesas por tipo</h3>
                            <div class="chart-box"><canvas id="chart-despesas"></canvas></div>
                        </div>
                        <div id="chart-despesas-mes-wrap" class="hidden mb-6 bg-white p-4 rounded-xl border border-gray-200">
                            <h3 class="font-semibold text-gray-800 mb-2">Total líquido por mês</h3>
                            <div class="chart-box"><canvas id="chart-despesas-mes"></canvas></div>
                        </div>
                        <div id="chart-fornecedores-wrap" class="hidden mb-6 bg-white p-4 rounded-xl border border-gray-200">
                            <h3 class="font-semibold text-gray-800 mb-2">Maiores fornecedores (top 8)</h3>
                            <div class="chart-box"><canvas id="chart-fornecedores"></canvas></div>
                        </div>
                        <div id="loading-despesas" class="loading text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i>
                            <p class="mt-2 text-gray-600">Carregando...</p>
                        </div>
                        <div id="results-despesas" class="space-y-3"></div>
                    </div>

                    <!-- Proposições -->
                    <div id="content-camara-proposicoes" class="tab-content hidden">
                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6">
                            <h2 class="text-xl font-bold mb-4"><i class="fas fa-file-alt mr-2 text-blue-600"></i>Buscar Proposições</h2>
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                                <div class="md:col-span-2">
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Termo de busca</label>
                                    <input type="text" id="proposicao-termo" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="Palavras-chave na ementa">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Tipo</label>
                                    <select id="proposicao-tipo" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                                        <option value="">Todos</option>
                                        <option value="PL">PL</option><option value="PLP">PLP</option><option value="PEC">PEC</option>
                                        <option value="MPV">MPV</option><option value="PDL">PDL</option><option value="PDC">PDC</option>
                                        <option value="PLV">PLV</option><option value="REQ">REQ</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Ano</label>
                                    <input type="number" id="proposicao-ano" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="2024">
                                </div>
                            </div>
                            <button onclick="buscarProposicoes(1)" class="mt-4 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">
                                <i class="fas fa-search mr-2"></i>Buscar Proposições
                            </button>
                        </div>
                        <div id="loading-proposicoes" class="loading text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i>
                            <p class="mt-2 text-gray-600">Carregando...</p>
                        </div>
                        <div id="results-proposicoes" class="space-y-3"></div>
                    </div>

                    <!-- Votações -->
                    <div id="content-camara-votacoes" class="tab-content hidden">
                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6">
                            <h2 class="text-xl font-bold mb-4"><i class="fas fa-vote-yea mr-2 text-blue-600"></i>Buscar Votações</h2>
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Ano</label>
                                    <select id="votacao-ano" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"></select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Mês</label>
                                    <select id="votacao-mes" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                                        <option value="">Todos</option>
                                        <option value="1">Janeiro</option><option value="2">Fevereiro</option><option value="3">Março</option>
                                        <option value="4">Abril</option><option value="5">Maio</option><option value="6">Junho</option>
                                        <option value="7">Julho</option><option value="8">Agosto</option><option value="9">Setembro</option>
                                        <option value="10">Outubro</option><option value="11">Novembro</option><option value="12">Dezembro</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Resultado</label>
                                    <select id="votacao-filtro" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                                        <option value="">Todas</option>
                                        <option value="1">Apenas aprovadas</option>
                                        <option value="0">Apenas rejeitadas</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Buscar no texto</label>
                                    <input type="text" id="votacao-texto" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="Palavra no título/descrição">
                                </div>
                            </div>
                            <button onclick="buscarVotacoes(1)" class="mt-4 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">
                                <i class="fas fa-search mr-2"></i>Buscar Votações
                            </button>
                        </div>
                        <div id="chart-votacoes-wrap" class="hidden mb-6 bg-white p-4 rounded-xl border border-gray-200">
                            <div class="chart-box"><canvas id="chart-votacoes-resumo"></canvas></div>
                        </div>
                        <div id="loading-votacoes" class="loading text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i>
                            <p class="mt-2 text-gray-600">Carregando...</p>
                        </div>
                        <div id="results-votacoes" class="space-y-3"></div>
                    </div>

                    <!-- Senadores -->
                    <div id="content-senado-senadores" class="tab-content hidden">
                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6">
                            <h2 class="text-xl font-bold mb-4"><i class="fas fa-user-tie mr-2 text-emerald-600"></i>Senadores em Exercício</h2>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">UF</label>
                                    <input type="text" id="senador-uf" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent" placeholder="Ex: SP, RJ" maxlength="2">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Partido</label>
                                    <input type="text" id="senador-partido" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent" placeholder="Ex: MDB, PT" maxlength="10">
                                </div>
                            </div>
                            <button onclick="buscarSenadores()" class="mt-4 px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium">
                                <i class="fas fa-search mr-2"></i>Listar Senadores
                            </button>
                        </div>
                        <div id="chart-senadores-wrap" class="hidden mb-6 bg-white p-4 rounded-xl border border-gray-200">
                            <h3 class="font-semibold text-gray-800 mb-2">Senadores por partido (top 10)</h3>
                            <div class="chart-box"><canvas id="chart-senadores"></canvas></div>
                        </div>
                        <div id="loading-senadores" class="loading text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-emerald-600"></i>
                            <p class="mt-2 text-gray-600">Carregando...</p>
                        </div>
                        <div id="results-senadores" class="space-y-3"></div>
                    </div>

                    <!-- Matérias -->
                    <div id="content-senado-materias" class="tab-content hidden">
                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6">
                            <h2 class="text-xl font-bold mb-4"><i class="fas fa-gavel mr-2 text-emerald-600"></i>Buscar Matérias Legislativas</h2>
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Tipo</label>
                                    <select id="materia-tipo" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent">
                                        <option value="PLS">PLS — Projeto de Lei do Senado</option>
                                        <option value="PL">PL — Projeto de Lei</option>
                                        <option value="PEC">PEC — Emenda à Constituição</option>
                                        <option value="PLP">PLP — Projeto de Lei Complementar</option>
                                        <option value="PRS">PRS — Proj. de Resolução do Senado</option>
                                        <option value="MPV">MPV — Medida Provisória</option>
                                        <option value="PDL">PDL — Proj. de Decreto Legislativo</option>
                                        <option value="REQ">REQ — Requerimento</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Ano</label>
                                    <input type="number" id="materia-ano" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent" placeholder="2024">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Situação</label>
                                    <select id="materia-situacao" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent">
                                        <option value="">Todas as situações</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Buscar no texto</label>
                                    <input type="text" id="materia-filtro" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent" placeholder="Palavra na ementa/número">
                                </div>
                            </div>
                            <button onclick="buscarMaterias()" class="mt-4 px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium">
                                <i class="fas fa-search mr-2"></i>Buscar Matérias
                            </button>
                        </div>
                        <div id="loading-materias" class="loading text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-emerald-600"></i>
                            <p class="mt-2 text-gray-600">Carregando (o Senado pode demorar alguns segundos)...</p>
                        </div>
                        <div id="results-materias" class="space-y-3"></div>
                    </div>

                    <!-- Despesas Senado (CEAPS) -->
                    <div id="content-senado-despesas" class="tab-content hidden">
                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6">
                            <h2 class="text-xl font-bold mb-1"><i class="fas fa-coins mr-2 text-emerald-600"></i>Despesas da Cota Parlamentar (CEAPS)</h2>
                            <p class="text-sm text-gray-500 mb-4">Gastos de gabinete dos senadores, nota a nota. Escolha um senador para ver o detalhe ou deixe em branco para o ranking geral.</p>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Ano</label>
                                    <select id="senado-despesa-ano" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"></select>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Senador (opcional)</label>
                                    <input type="text" id="senado-despesa-senador" list="lista-senadores" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent" placeholder="Nome do senador">
                                    <datalist id="lista-senadores"></datalist>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">Mês</label>
                                    <select id="senado-despesa-mes" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent">
                                        <option value="">Todos</option>
                                        <option value="1">Janeiro</option><option value="2">Fevereiro</option><option value="3">Março</option>
                                        <option value="4">Abril</option><option value="5">Maio</option><option value="6">Junho</option>
                                        <option value="7">Julho</option><option value="8">Agosto</option><option value="9">Setembro</option>
                                        <option value="10">Outubro</option><option value="11">Novembro</option><option value="12">Dezembro</option>
                                    </select>
                                </div>
                            </div>
                            <button onclick="buscarDespesasSenado()" class="mt-4 px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium">
                                <i class="fas fa-search mr-2"></i>Buscar
                            </button>
                        </div>
                        <div id="chart-senado-ranking-wrap" class="hidden mb-6 bg-white p-4 rounded-xl border border-gray-200">
                            <h3 class="font-semibold text-gray-800 mb-2">Ranking de gastos por senador (top 10)</h3>
                            <div class="chart-box"><canvas id="chart-senado-ranking"></canvas></div>
                        </div>
                        <div id="chart-senado-despesas-wrap" class="hidden mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div class="bg-white p-4 rounded-xl border border-gray-200">
                                <h3 class="font-semibold text-gray-800 mb-2">Por tipo de despesa</h3>
                                <div class="chart-box"><canvas id="chart-senado-tipo"></canvas></div>
                            </div>
                            <div class="bg-white p-4 rounded-xl border border-gray-200">
                                <h3 class="font-semibold text-gray-800 mb-2">Por mês</h3>
                                <div class="chart-box"><canvas id="chart-senado-mes"></canvas></div>
                            </div>
                        </div>
                        <div id="loading-senado-despesas" class="loading text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-emerald-600"></i>
                            <p class="mt-2 text-gray-600">Carregando (arquivo anual do Senado, pode demorar alguns segundos)...</p>
                        </div>
                        <div id="results-senado-despesas" class="space-y-3"></div>
                    </div>

                </div>
            </div>
        </main>

        <footer class="bg-slate-900 text-slate-300 mt-12 py-6">
            <div class="container mx-auto px-4 text-center text-sm">
                <p>Dados oficiais: Câmara dos Deputados (dadosabertos.camara.leg.br) e Senado Federal (legis.senado.leg.br + adm.senado.gov.br)</p>
                <p class="mt-2 text-slate-400">
                    <a href="https://dadosabertos.camara.leg.br/" target="_blank" class="hover:text-white">API Câmara</a>
                    <span class="mx-1">|</span>
                    <a href="https://legis.senado.leg.br/dadosabertos/" target="_blank" class="hover:text-white">API Senado</a>
                    <span class="mx-1">|</span>
                    <span>versão 4.3-CEAP</span>
                    <span class="mx-1">|</span>
                    <a href="/api/health" class="hover:text-white">status da API</a>
                </p>
            </div>
        </footer>

        <div id="js-erro" class="hidden container mx-auto px-4 mt-4">
            <div class="bg-red-50 border border-red-200 text-red-800 text-sm rounded-xl p-4">
                <i class="fas fa-triangle-exclamation mr-2"></i>
                <strong>Não foi possível carregar <code>/static/app.js</code></strong> — os botões da página não funcionam sem ele.
                Verifique se o arquivo está na pasta de assets estáticos (ex.: <code>public/static/app.js</code>) e se o
                <code>wrangler.toml</code> tem <code>assets.directory</code> apontando para essa pasta.
            </div>
        </div>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script src="/static/app.js" onerror="(function(){var b=document.getElementById('js-erro');if(b)b.classList.remove('hidden');})()"></script>
    </body>
    </html>
  `)
)

export default app
