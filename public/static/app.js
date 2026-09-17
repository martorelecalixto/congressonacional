/* ============================================================================
 * Portal Legislativo Brasileiro — Front-end v4.2
 *
 * Correções v4.2 (aba Despesas/CEAP):
 *  - Nome do deputado não vazava mais da busca anterior para a atual
 *    (era exibido o nome errado ao digitar um ID manualmente).
 *  - "Carregar todas": barra de progresso determinística, botão permanece
 *    visível (desabilitado) durante o carregamento e o loop aborta sozinho
 *    se o usuário trocar de deputado/ano/mês no meio (corrida de estado).
 *  - Erro de busca ganha botão "Tentar novamente" + dica quando é o
 *    rate-limit (HTTP 429) da API da Câmara — causa mais comum da aba
 *    "não funcionar".
 *  - Resumo parcial (amostra) avisa explicitamente via toast.
 *  - Link "Página oficial" do deputado ao lado do exportar CSV.
 *
 * Correções v4.1 (aba Despesas/CEAP):
 *  - Validação do código do deputado (apenas números) com mensagem clara.
 *  - Gráfico "Total líquido por mês" (o back-end já retornava porMes, mas o
 *    front nunca o exibia).
 *  - Botão "Carregar todas as páginas" com progresso e teto de segurança.
 *  - Histórico de buscas recentes (localStorage) com chips de acesso rápido.
 *  - Cards de métricas: documentos, total líquido, média e maior despesa.
 *  - Auto-busca ao trocar ano/mês quando o código já está preenchido.
 *  - Resumo não derruba mais a lista: falha no resumo só esconde os gráficos.
 *
 * Correções v4 (mantidas):
 *  - Guard de sequência (reqSeq) contra respostas fora de ordem.
 *  - Despesas: detecção de fim de paginação sem link "last", filtro, ordenação,
 *    gráfico de fornecedores, export filtrado.
 *  - Votações: badge "Sem resultado", filtros, gráfico-resumo, export, modal.
 *  - Matérias: filtros por situação/texto, export CSV.
 *  - Toasts, modal de detalhe do deputado.
 * ========================================================================== */

'use strict';

/* ------------------------------- Utilitários ------------------------------ */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const PALETA = ['#2563eb','#16a34a','#dc2626','#f59e0b','#7c3aed','#0891b2',
                '#db2777','#65a30d','#ea580c','#4f46e5'];

const fmtBRL = (v) =>
  Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDateBR = (iso) => {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}/.test(String(iso))) {
    const [a, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  }
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleDateString('pt-BR');
};

const fmtDateTimeBR = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? String(iso)
    : `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const debounce = (fn, ms = 400) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/**
 * Guard de sequência: toda busca assíncrona incrementa o contador do seu
 * namespace. Se, ao terminar, o contador mudou (outra busca começou), o
 * resultado é descartado.
 */
const reqSeq = {};
const beginReq = (ns) => (reqSeq[ns] = (reqSeq[ns] || 0) + 1);
const isStale = (ns, seq) => reqSeq[ns] !== seq;

/** Exibe a mensagem de erro real devolvida pelo backend. */
async function apiGet(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
  ).toString();
  try {
    const res = await axios.get(`/api${path}${qs ? `?${qs}` : ''}`);
    return res.data;
  } catch (err) {
    const d = err?.response?.data;
    const detalhe = (d && (d.error || d.detalhe)) || err?.message;
    throw new Error(detalhe || 'Erro de comunicação com o servidor');
  }
}

const setLoading = (el, on) => el?.classList.toggle('active', on);

function renderMessage(resultsEl, type, msg) {
  if (!resultsEl) return;
  const map = {
    empty: ['fa-inbox', 'text-center py-8 text-gray-500'],
    error: ['fa-exclamation-circle', 'bg-red-50 border border-red-200 rounded-xl p-4 text-red-800 text-sm'],
    info:  ['fa-info-circle', 'bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-yellow-800 text-sm'],
  };
  const [icon, cls] = map[type] || map.info;
  resultsEl.innerHTML =
    `<div class="${cls}"><i class="fas ${icon} ${type === 'empty' ? 'text-4xl mb-2 block' : 'mr-2'}"></i>${msg}</div>`;
}

/* --------------------------------- Toasts --------------------------------- */

function toast(msg, tipo = 'ok') {
  const wrap = $('#toast-wrap');
  if (!wrap) return;
  const cores = {
    ok:   'bg-slate-900 text-white',
    erro: 'bg-red-600 text-white',
    info: 'bg-blue-600 text-white',
  };
  const icones = { ok: 'fa-check-circle', erro: 'fa-exclamation-circle', info: 'fa-info-circle' };
  const el = document.createElement('div');
  el.className = `toast-item ${cores[tipo] || cores.ok} text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2`;
  el.innerHTML = `<i class="fas ${icones[tipo] || icones.ok}"></i><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 350);
  }, 2800);
}

const bindEnter = (inputId, fn) => {
  $(`#${inputId}`)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(); });
};

function copiar(texto) {
  navigator.clipboard?.writeText(String(texto))
    .then(() => toast('Copiado para a área de transferência'))
    .catch(() => toast('Não foi possível copiar', 'erro'));
}

function exportarCSV(nomeArquivo, linhas) {
  const csv = linhas
    .map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nomeArquivo;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV exportado');
}

/* -------------------------------- Gráficos -------------------------------- */

const chartRegistry = {};
let chartDefaultsSet = false;

function setupChartDefaults() {
  if (chartDefaultsSet || typeof Chart === 'undefined') return;
  chartDefaultsSet = true;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.borderColor = '#e5e7eb';
  Chart.defaults.plugins.legend.labels.boxWidth = 14;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1e293b';
}

/** Renderiza gráfico em um canvas dentro de .chart-box (altura fixa, responsivo). */
function renderChart(wrapId, canvasId, config) {
  const wrap = document.getElementById(wrapId);
  const canvas = document.getElementById(canvasId);
  if (!wrap || !canvas) return;
  if (typeof Chart === 'undefined') { console.warn('Chart.js não carregado'); return; }
  setupChartDefaults();
  config.options = Object.assign({}, config.options, { maintainAspectRatio: false });
  wrap.classList.remove('hidden');
  chartRegistry[canvasId]?.destroy();
  chartRegistry[canvasId] = new Chart(canvas, config);
}

function hideChart(wrapId) {
  document.getElementById(wrapId)?.classList.add('hidden');
}

function barConfig(labels, data, label, cor = '#2563eb') {
  return {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: cor, borderRadius: 6 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  };
}

function barHorizontalConfig(labels, data, label, cor = '#2563eb') {
  return {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: cor, borderRadius: 6 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } },
    },
  };
}

function doughConfig(labels, data, cores, extras = {}) {
  return {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: cores, borderWidth: 1 }] },
    options: Object.assign({
      responsive: true,
      plugins: { legend: { position: 'right' } },
    }, extras),
  };
}

/* --------------------------- Gerenciamento de abas ------------------------ */

function changeTab(tabName) {
  $$('.tab-content').forEach((c) => c.classList.add('hidden'));
  $$('.tab-button').forEach((b) => {
    b.classList.remove('border-blue-500', 'border-emerald-500', 'text-blue-600', 'text-emerald-600');
    b.classList.add('border-transparent', 'text-gray-500');
    b.setAttribute('aria-selected', 'false');
  });

  const content = $(`#content-${tabName}`);
  const tab = $(`#tab-${tabName}`);
  if (!content || !tab) { console.warn(`changeTab: aba desconhecida "${tabName}"`); return; }

  const cor = tabName.startsWith('senado')
    ? ['border-emerald-500', 'text-emerald-600']
    : ['border-blue-500', 'text-blue-600'];

  content.classList.remove('hidden');
  tab.classList.remove('border-transparent', 'text-gray-500');
  tab.classList.add(...cor);
  tab.setAttribute('aria-selected', 'true');
}

/* =============================== CÂMARA =================================== */

let ultimoDeputadoNome = '';
const deputadosPorId = {};

async function buscarDeputados(paginaSolicitada = 1) {
  const ns = 'deputados';
  const seq = beginReq(ns);

  const loading = $('#loading-deputados');
  const results = $('#results-deputados');

  const pagina = Math.max(1, Number(paginaSolicitada) || 1);

  const params = {
    nome: $('#deputado-nome')?.value.trim(),
    partido: $('#deputado-partido')?.value.trim().toUpperCase(),
    uf: $('#deputado-uf')?.value.trim().toUpperCase(),
    pagina: pagina,
    itens: 100
  };

  setLoading(loading, true);
  results.innerHTML = '';

  try {
    const data = await apiGet('/camara/deputados', params);

    if (isStale(ns, seq)) return;

    const deputados = Array.isArray(data?.dados)
      ? data.dados
      : [];

    deputados.forEach((d) => {
      if (d?.id != null) {
        deputadosPorId[d.id] = d.nome;
      }
    });

    setLoading(loading, false);

    if (!deputados.length) {
      hideChart('chart-deputados-wrap');

      return renderMessage(
        results,
        'empty',
        'Nenhum deputado encontrado'
      );
    }

    /*
     * Informações retornadas pelo backend.
     */
    const paginaAtual = Number(data?.pagina ?? pagina);
    const totalPaginas = Number(data?.totalPaginas ?? 1);
    const total = Number(data?.total ?? deputados.length);

    const temAnterior =
      data?.temAnterior === true ||
      paginaAtual > 1;

    const temProxima =
      data?.temProxima === true ||
      paginaAtual < totalPaginas;

    /*
     * Monta os cards dos deputados.
     */
    const lista = deputados.map((dep) => `
      <div class="result-item bg-white p-4 rounded-xl border border-gray-200">

        <div class="flex items-start justify-between gap-4">

          <div class="flex items-center space-x-4 min-w-0">

            <img
              src="${escapeHtml(dep.urlFoto || '')}"
              alt="${escapeHtml(dep.nome || '')}"
              class="w-16 h-16 rounded-full object-cover bg-gray-100 shrink-0"
              onerror="this.style.visibility='hidden'"
            >

            <div class="min-w-0">

              <h3 class="font-semibold text-lg">
                ${escapeHtml(dep.nome || 'Nome não informado')}
              </h3>

              <p class="text-sm text-gray-600 mt-1">

                <span class="inline-block bg-blue-100 text-blue-800 px-2 py-0.5 rounded mr-2">
                  ${escapeHtml(dep.siglaPartido || '—')}
                </span>

                <span class="inline-block bg-gray-100 text-gray-800 px-2 py-0.5 rounded">
                  ${escapeHtml(dep.siglaUf || '—')}
                </span>

              </p>

              <p class="text-xs text-gray-500 mt-1">
                ID: ${dep.id}
                ·
                ${escapeHtml(dep.email || 'email não informado')}
              </p>

            </div>

          </div>

          <div class="flex flex-col gap-2 shrink-0">

            <button
              onclick="verDespesasDeputado(${dep.id}, this.dataset.nome)"
              data-nome="${escapeHtml(dep.nome || '')}"
              class="text-xs bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700"
            >
              <i class="fas fa-receipt mr-1"></i>
              Despesas
            </button>

            <button
              onclick="verDetalheDeputado(${dep.id})"
              class="text-xs border border-gray-300 px-3 py-2 rounded-lg hover:bg-gray-50"
            >
              <i class="fas fa-id-card mr-1"></i>
              Detalhes
            </button>

            <button
              onclick="copiar(${dep.id})"
              class="text-xs border border-gray-300 px-3 py-2 rounded-lg hover:bg-gray-50"
            >
              <i class="fas fa-copy mr-1"></i>
              Copiar ID
            </button>

          </div>

        </div>

      </div>
    `).join('');

    /*
     * Contagem por partido.
     */
    const contagem = {};

    deputados.forEach((d) => {
      const partido = d.siglaPartido || '—';

      contagem[partido] =
        (contagem[partido] || 0) + 1;
    });

    const top = Object.entries(contagem)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    /*
     * Monta a paginação.
     */
    const paginacao = `
      <div class="mt-6 mb-4 p-4 bg-white border border-gray-200 rounded-xl">

        <div class="flex flex-col sm:flex-row items-center justify-between gap-3">

          <div class="text-sm text-gray-600">
            <i class="fas fa-users mr-2 text-blue-600"></i>

            <strong>${deputados.length}</strong>
            deputado(s) exibido(s)

            ${
              total > deputados.length
                ? ` de <strong>${total}</strong> resultado(s)`
                : ''
            }

          </div>

          <div class="flex items-center gap-2">

            <button
              type="button"
              onclick="buscarDeputados(${paginaAtual - 1})"
              ${!temAnterior ? 'disabled' : ''}
              class="
                px-3 py-2 rounded-lg border text-sm
                ${temAnterior
                  ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 cursor-pointer'
                  : 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                }
              "
            >
              <i class="fas fa-chevron-left mr-1"></i>
              Anterior
            </button>

            <span class="px-4 py-2 text-sm font-medium text-gray-700">
              Página ${paginaAtual} de ${totalPaginas}
            </span>

            <button
              type="button"
              onclick="buscarDeputados(${paginaAtual + 1})"
              ${!temProxima ? 'disabled' : ''}
              class="
                px-3 py-2 rounded-lg border text-sm
                ${temProxima
                  ? 'border-orange-300 bg-orange-600 text-white hover:bg-orange-700 cursor-pointer'
                  : 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                }
              "
            >
              Próxima
              <i class="fas fa-chevron-right ml-1"></i>
            </button>

          </div>

        </div>

      </div>
    `;

    /*
     * Exibe resultados + paginação.
     */
    results.innerHTML = paginacao + lista;

    /*
     * Renderiza o gráfico.
     */
    if (!top.length) {
      hideChart('chart-deputados-wrap');
    } else {
      renderChart(
        'chart-deputados-wrap',
        'chart-deputados',
        barConfig(
          top.map(([partido]) => partido),
          top.map(([, quantidade]) => quantidade),
          'Deputados por partido',
          '#2563eb'
        )
      );
    }

  } catch (err) {

    if (isStale(ns, seq)) return;

    setLoading(loading, false);

    console.error('buscarDeputados:', err);

    const mensagem =
      err instanceof Error
        ? err.message
        : String(err);

    renderMessage(
      results,
      'error',
      'Erro ao buscar deputados: ' + escapeHtml(mensagem)
    );
  }
}



/*versao 20290917-1513 (funcionando)
async function buscarDeputados() {
  const ns = 'deputados';
  const seq = beginReq(ns);
  const loading = $('#loading-deputados');
  const results = $('#results-deputados');
  const params = {
    nome:    $('#deputado-nome')?.value.trim(),
    partido: $('#deputado-partido')?.value.trim().toUpperCase(),
    uf:      $('#deputado-uf')?.value.trim().toUpperCase(),
    itens:   100,
  };

  setLoading(loading, true);
  results.innerHTML = '';

  try {
    const data = await apiGet('/camara/deputados', params);
    if (isStale(ns, seq)) return;
    const deputados = data.dados ?? [];
    deputados.forEach((d) => { deputadosPorId[d.id] = d.nome; });
    setLoading(loading, false);

    if (!deputados.length) {
      hideChart('chart-deputados-wrap');
      return renderMessage(results, 'empty', 'Nenhum deputado encontrado');
    }

    results.innerHTML = deputados.map((dep) => `
      <div class="result-item bg-white p-4 rounded-xl border border-gray-200">
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-center space-x-4 min-w-0">
            <img src="${escapeHtml(dep.urlFoto || '')}" alt="${escapeHtml(dep.nome)}"
                 class="w-16 h-16 rounded-full object-cover bg-gray-100 shrink-0"
                 onerror="this.style.visibility='hidden'">
            <div class="min-w-0">
              <h3 class="font-semibold text-lg">${escapeHtml(dep.nome)}</h3>
              <p class="text-sm text-gray-600 mt-1">
                <span class="inline-block bg-blue-100 text-blue-800 px-2 py-0.5 rounded mr-2">${escapeHtml(dep.siglaPartido || '—')}</span>
                <span class="inline-block bg-gray-100 text-gray-800 px-2 py-0.5 rounded">${escapeHtml(dep.siglaUf || '—')}</span>
              </p>
              <p class="text-xs text-gray-500 mt-1">ID: ${dep.id} · ${escapeHtml(dep.email || 'email não informado')}</p>
            </div>
          </div>
          <div class="flex flex-col gap-2 shrink-0">
            <button onclick="verDespesasDeputado(${dep.id}, this.dataset.nome)" data-nome="${escapeHtml(dep.nome)}"
                    class="text-xs bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700">
              <i class="fas fa-receipt mr-1"></i>Despesas
            </button>
            <button onclick="verDetalheDeputado(${dep.id})"
                    class="text-xs border border-gray-300 px-3 py-2 rounded-lg hover:bg-gray-50">
              <i class="fas fa-id-card mr-1"></i>Detalhes
            </button>
            <button onclick="copiar(${dep.id})"
                    class="text-xs border border-gray-300 px-3 py-2 rounded-lg hover:bg-gray-50">
              <i class="fas fa-copy mr-1"></i>Copiar ID
            </button>
          </div>
        </div>
      </div>`).join('');

    const contagem = {};
    deputados.forEach((d) => { const p = d.siglaPartido || '—'; contagem[p] = (contagem[p] || 0) + 1; });
    const top = Object.entries(contagem).sort((a, b) => b[1] - a[1]).slice(0, 10);
    renderChart('chart-deputados-wrap', 'chart-deputados',
      barConfig(top.map(([p]) => p), top.map(([, n]) => n), 'Deputados por partido', '#2563eb'));
  } catch (err) {
    if (isStale(ns, seq)) return;
    setLoading(loading, false);
    console.error('buscarDeputados:', err);
    renderMessage(results, 'error', 'Erro ao buscar deputados: ' + escapeHtml(err.message));
  }
}
*/


/** Modal com dados cadastrais do deputado (gabinete, telefone etc.). */
async function verDetalheDeputado(id) {
  abrirModal(`Deputado #${id}`,
    `<div class="text-center py-6 text-gray-500"><i class="fas fa-spinner fa-spin text-2xl"></i><p class="mt-2">Carregando detalhes...</p></div>`);
  try {
    const data = await apiGet(`/camara/deputados/${id}`);
    const d = data.dados ?? {};
    const gab = d.gabinete ?? {};
    const linha = (rotulo, valor) => valor
      ? `<div class="flex justify-between gap-4 py-1.5 border-b border-gray-100 text-sm">
           <span class="text-gray-500">${rotulo}</span><span class="text-right font-medium">${escapeHtml(valor)}</span>
         </div>`
      : '';
    document.getElementById('modal-body').innerHTML = `
      <div class="flex items-center gap-4 mb-4">
        <img src="${escapeHtml(d.ultimoStatus?.urlFoto || d.urlFoto || '')}" alt=""
             class="w-20 h-20 rounded-full object-cover bg-gray-100" onerror="this.style.visibility='hidden'">
        <div>
          <p class="text-xl font-bold">${escapeHtml(d.nomeCivil || d.ultimoStatus?.nome || '—')}</p>
          <p class="text-sm text-gray-500">${escapeHtml(d.ultimoStatus?.siglaPartido || '')} - ${escapeHtml(d.ultimoStatus?.siglaUf || '')} · ${escapeHtml(d.ultimoStatus?.situacao || '')}</p>
        </div>
      </div>
      ${linha('Nome parlamentar', d.ultimoStatus?.nome)}
      ${linha('Nascimento', fmtDateBR(d.dataNascimento))}
      ${linha('CPF', d.cpf)}
      ${linha('Telefone', d.ultimoStatus?.gabinete?.telefone || gab.telefone)}
      ${linha('Gabinete', [gab.predio && `Prédio ${gab.predio}`, gab.sala && `Sala ${gab.sala}`, gab.andar && `${gab.andar}º andar`].filter(Boolean).join(' · '))}
      ${linha('E-mail gabinete', gab.email)}
      ${linha('E-mail', d.ultimoStatus?.email || d.email)}
      ${linha('Condição eleitoral', d.ultimoStatus?.condicaoEleitoral)}
      ${linha('Escolaridade', d.escolaridade)}
      ${linha('Municipio nascimento', [d.municipioNascimento, d.ufNascimento].filter(Boolean).join(' - '))}
      <a href="${escapeHtml(d.uri || `https://www.camara.leg.br/deputados/${id}`)}" target="_blank" rel="noopener"
         class="inline-block mt-4 text-sm text-blue-600 hover:underline">
        <i class="fas fa-external-link-alt mr-1"></i>Página oficial na Câmara
      </a>`;
  } catch (err) {
    console.error('verDetalheDeputado:', err);
    const body = document.getElementById('modal-body');
    if (body) body.innerHTML = `<p class="text-center text-red-600 py-4">Erro ao carregar detalhes: ${escapeHtml(err.message)}</p>`;
  }
}

/* --------------------------- Despesas (CEAP) ------------------------------ */

const despesasState = { codigo: null, ano: null, mes: null, pagina: 0, ultimaPagina: Infinity, itens: [], carregandoTudo: false };
const despesasFilter = { texto: '', ordenar: 'data_desc' };
const DESPESAS_POR_PAGINA = 100;
/** Teto de segurança para o "Carregar todas" (evita loop infinito se a API
 *  mudar o formato dos links de paginação). */
const CEAP_MAX_PAGINAS_AUTO = 40;
const CEAP_RECENTES_KEY = 'portal-ceap-recentes';

function extrairUltimaPagina(data, state) {
  const last = (data.links ?? []).find((l) => l.rel === 'last');
  if (last) {
    try {
      const p = Number(new URL(last.href).searchParams.get('pagina'));
      if (Number.isFinite(p) && p > 0) state.ultimaPagina = p;
    } catch { /* mantém Infinity */ }
  }
}

/* ----- Histórico local de buscas CEAP (chips de acesso rápido) ------------ */

function ceapRecentes() {
  try { return JSON.parse(localStorage.getItem(CEAP_RECENTES_KEY) || '[]'); }
  catch { return []; }
}

function registrarBuscaCEAP(codigo, nome) {
  if (!codigo) return;
  const nomeLimpo = (nome || deputadosPorId[codigo] || '').trim();
  const lista = ceapRecentes().filter((r) => r.codigo !== String(codigo));
  lista.unshift({ codigo: String(codigo), nome: nomeLimpo });
  try { localStorage.setItem(CEAP_RECENTES_KEY, JSON.stringify(lista.slice(0, 6))); }
  catch { /* armazenamento indisponível — segue sem histórico */ }
  renderCEAPRecentes();
}

function renderCEAPRecentes() {
  const wrap = $('#ceap-recentes');
  if (!wrap) return;
  const lista = ceapRecentes();
  if (!lista.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <span class="text-xs text-gray-500"><i class="fas fa-history mr-1"></i>Buscas recentes:</span>
      ${lista.map((r) => `
        <button onclick="buscarCEAPRecente('${escapeHtml(r.codigo)}')"
                class="text-xs bg-white border border-gray-300 px-3 py-1 rounded-full hover:border-blue-400 hover:text-blue-600 transition-colors"
                title="ID ${escapeHtml(r.codigo)}">
          <i class="fas fa-user mr-1"></i>${escapeHtml(r.nome || 'ID ' + r.codigo)}
        </button>`).join('')}
      <button onclick="limparCEAPRecentes()" class="text-xs text-gray-400 hover:text-red-500 transition-colors"
              title="Limpar histórico"><i class="fas fa-trash-alt"></i></button>
    </div>`;
}

function buscarCEAPRecente(codigo) {
  const campo = $('#deputado-codigo');
  if (campo) campo.value = codigo;
  ultimoDeputadoNome = ceapRecentes().find((r) => r.codigo === String(codigo))?.nome
    || deputadosPorId[codigo] || '';
  buscarDespesasDeputados(1);
}

function limparCEAPRecentes() {
  localStorage.removeItem(CEAP_RECENTES_KEY);
  renderCEAPRecentes();
}

/* ------------------------------ Busca CEAP -------------------------------- */

async function buscarDespesasDeputados(pagina = 1) {
  const ns = 'despesas';
  const seq = beginReq(ns);
  const codigo = ($('#deputado-codigo')?.value || '').trim();
  const ano    = ($('#despesa-ano')?.value || '').trim();
  const mes    = ($('#despesa-mes')?.value || '').trim();
  const loading = $('#loading-despesas');
  const results = $('#results-despesas');

  // CORREÇÃO: validação clara do código antes de chamar a API — antes, texto
  // digitado por engano gerava erro genérico do upstream.
  if (!codigo) {
    despesasState.itens = [];
    hideChart('chart-despesas-wrap');
    hideChart('chart-fornecedores-wrap');
    hideChart('chart-despesas-mes-wrap');
    setLoading(loading, false);
    return renderMessage(results, 'info', 'Informe o ID (código) do deputado. Dica: use o botão "Despesas" no card de um deputado da primeira aba.');
  }
  if (!/^\d+$/.test(codigo)) {
    despesasState.itens = [];
    hideChart('chart-despesas-wrap');
    hideChart('chart-fornecedores-wrap');
    hideChart('chart-despesas-mes-wrap');
    setLoading(loading, false);
    toast('O código deve conter apenas números (ex.: 204379). Para buscar pelo nome, use a aba Deputados.', 'erro');
    return renderMessage(results, 'error',
      'Código inválido: <strong>' + escapeHtml(codigo) + '</strong>. O ID deve ser numérico — busque o deputado na aba "Deputados" e clique em "Despesas".');
  }

  // Evita conflito com um "Carregar todas" em andamento
  if (despesasState.carregandoTudo && pagina !== 1) return;

  if (pagina === 1) {
    despesasState.itens = [];
    despesasState.codigo = codigo;
    despesasState.ano = ano;
    despesasState.mes = mes;
    despesasState.pagina = 0;
    despesasState.ultimaPagina = Infinity;
    despesasState.carregandoTudo = false;
    despesasFilter.texto = '';
    despesasFilter.ordenar = 'data_desc';
    const f = $('#despesa-filtro'); if (f) f.value = '';
    const o = $('#despesa-ordenar'); if (o) o.value = 'data_desc';
    // CORREÇÃO v4.2: antes, o nome da busca anterior "vazava" para a nova
    // (ao digitar outro ID manualmente, os cards mostravam o nome antigo).
    const nomeDoMapa = deputadosPorId[codigo];
    if (nomeDoMapa) ultimoDeputadoNome = nomeDoMapa;
    results.innerHTML = '';
    hideChart('chart-despesas-wrap');
    hideChart('chart-fornecedores-wrap');
    hideChart('chart-despesas-mes-wrap');
  }

  setLoading(loading, true);

  try {
    const data  = await apiGet('/camara/despesas', { codigo, ano, mes, pagina, itens: DESPESAS_POR_PAGINA });
    if (isStale(ns, seq)) return;
    const novas = data.dados ?? [];
    extrairUltimaPagina(data, despesasState);
    // A API nem sempre envia link "last"; se veio menos itens do que o
    // pedido, sabemos que é a última página.
    if (novas.length < DESPESAS_POR_PAGINA) despesasState.ultimaPagina = pagina;
    despesasState.pagina = pagina;
    despesasState.itens.push(...novas);
    setLoading(loading, false);

    if (!despesasState.itens.length) {
      hideChart('chart-despesas-wrap');
      hideChart('chart-fornecedores-wrap');
      hideChart('chart-despesas-mes-wrap');
      return renderMessage(results, 'empty',
        'Nenhuma despesa retornada para <strong>' + escapeHtml(codigo) + '</strong>' +
        (ano ? ' em ' + escapeHtml(ano) : '') +
        '. Verifique o ano (o ano corrente pode ainda não ter dados publicados) ou tente novamente em instantes.');
    }

    registrarBuscaCEAP(codigo, ultimoDeputadoNome);
    renderDespesas(results);
    if (pagina === 1) carregarResumoDespesas(codigo, ano, mes);
  } catch (err) {
    if (isStale(ns, seq)) return;
    setLoading(loading, false);
    console.error('buscarDespesasDeputados:', err);
    // CORREÇÃO v4.2: o rate-limit (429) da API da Câmara é a causa mais
    // comum da aba "não funcionar" — explica e oferece retry em 1 clique.
    const ehRateLimit = /429|limitando/i.test(err.message || '');
    renderMessage(results, 'error',
      'Erro ao buscar despesas: ' + escapeHtml(err.message) +
      (ehRateLimit
        ? '<div class="mt-2 text-xs">A API da Câmara limita requisições por minuto (HTTP 429). Aguarde alguns segundos e tente novamente — o resumo em gráficos usa várias chamadas e é o mais afetado.</div>'
        : '') +
      `<div class="mt-3"><button onclick="buscarDespesasDeputados(1)"
        class="text-xs bg-red-600 text-white px-3 py-1.5 rounded-lg hover:bg-red-700">
        <i class="fas fa-rotate-right mr-1"></i>Tentar novamente</button></div>`);
  }
}

/**
 * Carrega todas as páginas restantes de forma sequencial, com barra de
 * progresso (determinística quando o total de páginas é conhecido) e teto
 * de segurança. CORREÇÃO v4.2: aborta sozinho se o usuário iniciar outra
 * busca (troca de deputado/ano/mês) no meio do processo.
 */
async function carregarTodasDespesas() {
  if (despesasState.carregandoTudo) return;
  if (!despesasState.codigo || !(despesasState.pagina < despesasState.ultimaPagina)) return;

  const ns = 'despesas';
  // Congela o contexto: se o estado mudar (nova busca), o loop para.
  const ctx = { codigo: despesasState.codigo, ano: despesasState.ano, mes: despesasState.mes };
  const seq = beginReq(ns);
  despesasState.carregandoTudo = true;

  const atualizarProgresso = () => {
    const barra = $('#ceap-progress');
    const rotulo = $('#ceap-progress-label');
    if (!barra || !rotulo) return;
    const conhecido = despesasState.ultimaPagina !== Infinity;
    const alvo = conhecido ? despesasState.ultimaPagina : CEAP_MAX_PAGINAS_AUTO;
    const pct = Math.min(100, Math.round((despesasState.pagina / alvo) * 100));
    barra.style.width = pct + '%';
    rotulo.textContent = conhecido
      ? `página ${despesasState.pagina} de ${despesasState.ultimaPagina}`
      : `página ${despesasState.pagina} (total ainda desconhecido)`;
  };
  atualizarProgresso();

  try {
    let p = despesasState.pagina + 1;
    while (
      p <= despesasState.ultimaPagina &&
      p <= CEAP_MAX_PAGINAS_AUTO &&
      despesasState.carregandoTudo &&
      despesasState.codigo === ctx.codigo &&
      despesasState.ano === ctx.ano &&
      despesasState.mes === ctx.mes
    ) {
      const data = await apiGet('/camara/despesas', {
        codigo: ctx.codigo, ano: ctx.ano, mes: ctx.mes,
        pagina: p, itens: DESPESAS_POR_PAGINA,
      });
      if (isStale(ns, seq)) return;
      const novas = data.dados ?? [];
      extrairUltimaPagina(data, despesasState);
      if (novas.length < DESPESAS_POR_PAGINA) despesasState.ultimaPagina = p;
      despesasState.pagina = p;
      despesasState.itens.push(...novas);
      renderDespesas($('#results-despesas'));
      atualizarProgresso();
      if (!novas.length) break;
      p++;
    }
    if (despesasState.ultimaPagina > CEAP_MAX_PAGINAS_AUTO) {
      despesasState.ultimaPagina = despesasState.pagina;
      toast(`Limite de ${CEAP_MAX_PAGINAS_AUTO * DESPESAS_POR_PAGINA} documentos atingido — refine por ano/mês para ver o restante.`, 'info');
    } else {
      toast(`Todas as ${despesasState.itens.length} despesas do período foram carregadas.`);
    }
  } catch (err) {
    console.error('carregarTodasDespesas:', err);
    toast('Interrompido: ' + err.message, 'erro');
  } finally {
    // Só limpa/re-renderiza se a busca atual ainda for a mesma (sem corrida).
    if (despesasState.codigo === ctx.codigo && despesasState.ano === ctx.ano && despesasState.mes === ctx.mes) {
      despesasState.carregandoTudo = false;
      renderDespesas($('#results-despesas'));
    }
  }
}

/** Resumo agregado (gráficos). Falha aqui NÃO derruba a lista de despesas. */
async function carregarResumoDespesas(codigo, ano, mes) {
  try {
    const resumo = await apiGet(`/camara/despesas/${encodeURIComponent(codigo)}/resumo`, { ano, mes });
    if (resumo.amostra) {
      toast(`Resumo parcial: calculado sobre ${resumo.paginasColetadas ?? '?'} página(s) — clique em "Carregar todas" para o detalhe completo.`, 'info');
    }
    const porTipo = (resumo.porTipo ?? []).slice(0, 8);

    if (porTipo.length) {
      renderChart('chart-despesas-wrap', 'chart-despesas', {
        type: 'doughnut',
        data: {
          labels: porTipo.map((t) => t.tipo),
          datasets: [{ data: porTipo.map((t) => t.total), backgroundColor: PALETA, borderWidth: 1 }],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { position: 'right' },
            tooltip: { callbacks: { label: (ctx) => ` ${fmtBRL(ctx.parsed)}` } },
            title: {
              display: true,
              text: `${resumo.quantidade} documento(s) · Total líquido ${fmtBRL(resumo.totalLiquido)}${resumo.amostra ? ' (amostra)' : ''}`,
            },
          },
        },
      });
    } else {
      hideChart('chart-despesas-wrap');
    }

    // NOVO: gráfico de evolução mensal — o backend já retornava porMes,
    // mas o front nunca o exibia.
    const porMes = (resumo.porMes ?? []).filter((m) => m.mes && m.mes !== '—');
    if (porMes.length) {
      renderChart('chart-despesas-mes-wrap', 'chart-despesas-mes',
        barConfig(porMes.map((m) => m.mes), porMes.map((m) => m.total), 'Total líquido por mês', '#0891b2'));
    } else {
      hideChart('chart-despesas-mes-wrap');
    }

    // Fornecedores que mais receberam (agregado do backend).
    const porFornecedor = (resumo.porFornecedor ?? []).slice(0, 8);
    if (porFornecedor.length) {
      renderChart('chart-fornecedores-wrap', 'chart-fornecedores', {
        type: 'bar',
        data: {
          labels: porFornecedor.map((f) => (f.fornecedor || '—').slice(0, 28)),
          datasets: [{ label: 'Total líquido', data: porFornecedor.map((f) => f.total), backgroundColor: '#7c3aed', borderRadius: 6 }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => ` ${fmtBRL(ctx.parsed.x)}` } },
          },
          scales: { x: { beginAtZero: true } },
        },
      });
    } else {
      hideChart('chart-fornecedores-wrap');
    }
  } catch (err) {
    console.warn('carregarResumoDespesas:', err);
    hideChart('chart-despesas-wrap');
    hideChart('chart-fornecedores-wrap');
    hideChart('chart-despesas-mes-wrap');
  }
}









function despesasVisiveis() {
  const t = despesasFilter.texto.trim().toLowerCase();
  let lista = despesasState.itens;
  if (t) {
    lista = lista.filter((d) =>
      [d.tipoDespesa, d.nomeFornecedor, d.numDocumento, d.cnpjCpfFornecedor]
        .some((v) => String(v || '').toLowerCase().includes(t)));
  }
  lista = [...lista];
  const ord = despesasFilter.ordenar;
  if (ord === 'valor_desc') lista.sort((a, b) => Number(b.valorDocumento || 0) - Number(a.valorDocumento || 0));
  else if (ord === 'valor_asc') lista.sort((a, b) => Number(a.valorDocumento || 0) - Number(b.valorDocumento || 0));
  else if (ord === 'fornecedor') lista.sort((a, b) => String(a.nomeFornecedor || '').localeCompare(String(b.nomeFornecedor || '')));
  else lista.sort((a, b) => String(b.dataDocumento || '').localeCompare(String(a.dataDocumento || '')));
  return lista;
}


function renderDespesas(results) {
  const itens = despesasState.itens;
  const visiveis = despesasVisiveis();

  const total = visiveis.reduce(
    (s, d) => s + Number(d.valorDocumento || 0),
    0
  );

  const liquido = visiveis.reduce(
    (s, d) => s + Number(d.valorLiquido || 0),
    0
  );

  const maior = visiveis.reduce(
    (m, d) => Math.max(m, Number(d.valorDocumento || 0)),
    0
  );

  const media = visiveis.length ? liquido / visiveis.length : 0;
  const temMais = despesasState.pagina < despesasState.ultimaPagina;
  const filtrado = visiveis.length !== itens.length;

  const badge = (txt) =>
    `<span class="inline-block bg-blue-100 text-blue-800 px-2 py-0.5 rounded mr-2 mb-1">${escapeHtml(txt)}</span>`;

  const nomeExibicao =
    ultimoDeputadoNome ||
    deputadosPorId[despesasState.codigo] ||
    '';

  // ---------------------------------------------------------
  // TIPO DO DOCUMENTO
  // ---------------------------------------------------------
  const descricaoTipoDocumento = (tipo) => {
    const codigo = Number(tipo);

    switch (codigo) {
      case 0:
        return 'Nota fiscal';

      case 1:
        return 'Recibo / outros';

      case 2:
        return 'Documento emitido no exterior';

      case 3:
        return 'Despesa do Parlasul';

      case 4:
        return 'Nota fiscal eletrônica';

      case 5:
        return 'Nota fiscal eletrônica';

      default:
        return tipo !== undefined && tipo !== null && tipo !== ''
          ? `Documento (${escapeHtml(String(tipo))})`
          : 'Documento';
    }
  };

  // ---------------------------------------------------------
  // LINK / DISPONIBILIDADE DO DOCUMENTO
  // ---------------------------------------------------------
  const linkDocumento = (url) => {
    if (!url) {
      return '';
    }

    const urlLower = String(url).toLowerCase();

    // A Câmara informa que o documento eletrônico não existe.
    if (
      urlLower.includes('cota-nota-fiscal-eletronica-inexistente') ||
      urlLower.includes('nota-fiscal-eletronica-inexistente')
    ) {
      return `
        <div class="mt-3">
          <span
            class="inline-flex items-center text-xs bg-gray-50 text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg"
            title="A Câmara dos Deputados informa que o documento eletrônico não está disponível">
            <i class="fas fa-file-circle-xmark mr-1.5"></i>
            Documento não disponível
          </span>
        </div>
      `;
    }

    // Documento PDF oficial
    if (urlLower.includes('.pdf')) {
      return `
        <div class="mt-3">
          <a
            href="${escapeHtml(url)}"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center text-xs bg-blue-50 text-blue-700 border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-100">
            <i class="fas fa-file-pdf mr-1.5"></i>
            Ver documento PDF
          </a>
        </div>
      `;
    }

    // Outros documentos oficiais
    return `
      <div class="mt-3">
        <a
          href="${escapeHtml(url)}"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center text-xs bg-blue-50 text-blue-700 border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-100">
          <i class="fas fa-file-lines mr-1.5"></i>
          Abrir documento oficial
        </a>
      </div>
    `;
  };

  // ---------------------------------------------------------
  // TOPO / RESUMO
  // ---------------------------------------------------------
  const topo = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">

      <div class="bg-white border border-gray-200 rounded-xl p-3">
        <p class="text-xs text-gray-500">
          <i class="fas fa-file-invoice mr-1"></i>Documentos
        </p>
        <p class="text-lg font-bold text-gray-800">
          ${visiveis.length}
          ${filtrado
            ? `<span class="text-xs font-normal text-gray-400"> de ${itens.length}</span>`
            : ''}
        </p>
      </div>

      <div class="bg-white border border-gray-200 rounded-xl p-3">
        <p class="text-xs text-gray-500">
          <i class="fas fa-wallet mr-1"></i>Total líquido
        </p>
        <p class="text-lg font-bold text-blue-700">
          ${fmtBRL(liquido)}
        </p>
      </div>

      <div class="bg-white border border-gray-200 rounded-xl p-3">
        <p class="text-xs text-gray-500">
          <i class="fas fa-divide mr-1"></i>Média por documento
        </p>
        <p class="text-lg font-bold text-gray-800">
          ${fmtBRL(media)}
        </p>
      </div>

      <div class="bg-white border border-gray-200 rounded-xl p-3">
        <p class="text-xs text-gray-500">
          <i class="fas fa-arrow-trend-up mr-1"></i>Maior despesa
        </p>
        <p class="text-lg font-bold text-gray-800">
          ${fmtBRL(maior)}
        </p>
      </div>

    </div>

    <div class="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-wrap items-center gap-3">

      <p class="text-sm text-gray-600">
        <i class="fas fa-calculator mr-1"></i>
        Total documento:
        <strong>${fmtBRL(total)}</strong>

        ${
          nomeExibicao
            ? ` — <strong>${escapeHtml(nomeExibicao)}</strong>`
            : ` — deputado ${escapeHtml(despesasState.codigo || '')}`
        }

        ${
          filtrado
            ? `<span class="text-xs text-gray-400">(valores refletem o filtro)</span>`
            : ''
        }
      </p>

      <div class="flex gap-2 ml-auto items-center flex-wrap justify-end">

        <button
          onclick="exportarDespesasCSV()"
          class="text-xs border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50">
          <i class="fas fa-file-csv mr-1"></i>
          Exportar CSV${filtrado ? ' (filtrado)' : ''}
        </button>

        <a
          href="https://www.camara.leg.br/deputados/${encodeURIComponent(despesasState.codigo || '')}"
          target="_blank"
          rel="noopener"
          class="text-xs border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50">
          <i class="fas fa-external-link-alt mr-1"></i>
          Página oficial
        </a>

        ${
          temMais
            ? `
              <div class="flex flex-col items-end gap-1">
                <div class="w-40 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    id="ceap-progress"
                    class="h-full bg-blue-600 rounded-full transition-all duration-300"
                    style="width:0%">
                  </div>
                </div>

                <p
                  id="ceap-progress-label"
                  class="text-[11px] text-gray-400 leading-none m-0">
                </p>
              </div>

              <button
                id="btn-carregar-todas"
                onclick="carregarTodasDespesas()"
                class="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                ${despesasState.carregandoTudo ? 'disabled' : ''}>
                <i class="fas fa-download mr-1"></i>
                ${
                  despesasState.carregandoTudo
                    ? 'Carregando…'
                    : `Carregar todas${
                        despesasState.ultimaPagina !== Infinity
                          ? ` (${despesasState.ultimaPagina} págs.)`
                          : ''
                      }`
                }
              </button>
            `
            : ''
        }

      </div>
    </div>
  `;

  // ---------------------------------------------------------
  // NENHUM RESULTADO APÓS FILTRO
  // ---------------------------------------------------------
  if (!visiveis.length) {
    results.innerHTML =
      topo +
      `
        <div class="text-center py-6 text-gray-500 bg-white rounded-xl border border-gray-200">
          <i class="fas fa-filter text-2xl mb-2 block"></i>
          Nenhum documento corresponde ao filtro.
        </div>
      `;

    return;
  }

  // ---------------------------------------------------------
  // LISTA DE DESPESAS
  // ---------------------------------------------------------
  results.innerHTML =
    topo +

    visiveis.map((d) => {

      // Dados oficiais vindos do CEAP
      const descricao =
        d.descricao ||
        'Tipo não informado';

      const especificacao =
        d.descricaoEspecificacao ||
        '';

      const tipoDocumento =
        descricaoTipoDocumento(d.tipoDocumento);

      const numeroDocumento =
        d.numero ??
        '—';

      const dataEmissao =
        d.dataEmissao ||
        '';

      const cnpjCpf =
        d.cnpjCPF ||
        '—';

      const fornecedor =
        d.fornecedor ||
        '—';

      const urlDocumento =
        d.urlDocumento ||
        '';

      return `
        <div class="result-item bg-white p-4 rounded-xl border border-gray-200 mb-3">

          <!-- MÊS / ANO -->
          <h3 class="font-semibold text-lg">
            ${String(d.mes ?? '—').padStart(2, '0')}/${d.ano ?? '—'}
          </h3>

          <!-- TIPO DA DESPESA -->
          <p class="text-sm text-gray-600 mt-1">
            ${badge(descricao)}
          </p>

          ${
            especificacao
              ? `
                <p class="text-xs text-gray-500 mt-1">
                  <strong>Especificação:</strong>
                  ${escapeHtml(especificacao)}
                </p>
              `
              : ''
          }

          <!-- DOCUMENTO -->
          <p class="text-sm text-gray-600 mt-2">

            ${badge(tipoDocumento)}

            ${badge('Nº ' + numeroDocumento)}

            ${badge(
              'Data: ' +
              (dataEmissao
                ? fmtDateBR(dataEmissao)
                : '—')
            )}

          </p>

          <!-- FORNECEDOR -->
          <p class="text-sm text-gray-600 mt-1">

            <span class="inline-block bg-gray-100 px-2 py-0.5 rounded mr-2 mb-1">
              CNPJ/CPF:
              ${escapeHtml(cnpjCpf)}
            </span>

            <span class="inline-block bg-gray-100 px-2 py-0.5 rounded mb-1">
              Fornecedor:
              ${escapeHtml(fornecedor)}
            </span>

          </p>

          <!-- VALORES -->
          <p class="text-xs text-gray-500 mt-1">
            Valor:
            <strong>${fmtBRL(d.valorDocumento)}</strong>
            ·
            Líquido:
            <strong>${fmtBRL(d.valorLiquido)}</strong>
          </p>

          ${linkDocumento(urlDocumento)}

        </div>
      `;
    }).join('') +

    // -------------------------------------------------------
    // PAGINAÇÃO
    // -------------------------------------------------------
    `
      ${
        temMais
          ? `
            <div class="text-center mt-4">

              <button
                onclick="buscarDespesasDeputados(${despesasState.pagina + 1})"
                class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm">

                <i class="fas fa-plus mr-1"></i>

                Carregar mais
                (pág. ${despesasState.pagina + 1}${
                  despesasState.ultimaPagina === Infinity
                    ? ''
                    : ' de ' + despesasState.ultimaPagina
                })

              </button>

            </div>
          `
          : (
              itens.length > 50
                ? `
                  <p class="text-center text-xs text-gray-400 mt-4">
                    <i class="fas fa-flag-checkered mr-1"></i>
                    Todas as ${itens.length} despesas do período foram carregadas.
                  </p>
                `
                : ''
            )
      }
    `;
}





function exportarDespesasCSV() {
  const header = ['Ano', 'Mês', 'Tipo Despesa', 'Tipo Documento', 'Nº Documento', 'Data',
                  'CNPJ/CPF Fornecedor', 'Fornecedor', 'Valor Documento', 'Valor Líquido'];
  const linhas = despesasVisiveis().map((d) => [
    d.ano, d.mes, d.tipoDespesa, d.tipoDocumento, d.numDocumento, d.dataDocumento,
    d.cnpjCpfFornecedor, d.nomeFornecedor,
    String(d.valorDocumento ?? '').replace('.', ','), String(d.valorLiquido ?? '').replace('.', ','),
  ]);
  exportarCSV(`despesas_deputado_${despesasState.codigo}.csv`, [header, ...linhas]);
} 









function verDespesasDeputado(id, nome) {
  const campo = $('#deputado-codigo');
  if (campo) campo.value = id;
  ultimoDeputadoNome = nome || deputadosPorId[id] || '';
  registrarBuscaCEAP(id, ultimoDeputadoNome);
  changeTab('camara-despesas');
  buscarDespesasDeputados(1);
}

/* ----------------------------- Proposições -------------------------------- */

const propState = { pagina: 1, ultimaPagina: Infinity, itens: [] };

async function buscarProposicoes(pagina = 1) {
  const ns = 'proposicoes';
  const seq = beginReq(ns);
  const termo = $('#proposicao-termo')?.value.trim();
  const ano   = $('#proposicao-ano')?.value.trim();
  const tipo  = $('#proposicao-tipo')?.value.trim();
  const loading = $('#loading-proposicoes');
  const results = $('#results-proposicoes');

  if (pagina === 1) {
    propState.itens = [];
    propState.ultimaPagina = Infinity;
    results.innerHTML = '';
  }

  setLoading(loading, true);

  try {
    const data = await apiGet('/camara/proposicoes', { ano, termo, tipo, pagina, itens: 50 });
    if (isStale(ns, seq)) return;
    const novas = data.dados ?? [];
    extrairUltimaPagina(data, propState);
    propState.pagina = pagina;
    propState.itens.push(...novas);
    setLoading(loading, false);

    if (!propState.itens.length) return renderMessage(results, 'empty', 'Nenhuma proposição encontrada');

    const temMais = propState.pagina < propState.ultimaPagina;
    results.innerHTML = `
      <div class="mb-4 text-sm text-gray-600 flex flex-wrap items-center gap-3">
        <span><i class="fas fa-info-circle mr-2"></i>${propState.itens.length} resultado(s) carregado(s)
        ${propState.ultimaPagina !== Infinity ? `· ${propState.ultimaPagina} página(s) no total` : ''}</span>
        <button onclick="exportarProposicoesCSV()" class="text-xs border border-gray-300 px-3 py-1 rounded-lg hover:bg-gray-50">
          <i class="fas fa-file-csv mr-1"></i>Exportar CSV
        </button>
      </div>
    ` + propState.itens.map((prop) => `
      <div class="result-item bg-white p-4 rounded-xl border border-gray-200">
        <div class="flex items-start justify-between mb-2 gap-2">
          <h3 class="font-semibold">${escapeHtml(prop.siglaTipo || '')} ${prop.numero ?? ''}/${prop.ano ?? ''}</h3>
          <span class="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded shrink-0">ID: ${prop.id}</span>
        </div>
        <p class="text-sm text-gray-700 mb-2">${escapeHtml(prop.ementa || 'Sem ementa disponível')}</p>
        <div class="flex items-center space-x-2 text-xs text-gray-500">
          <span><i class="far fa-calendar mr-1"></i>${prop.ano ?? '—'}</span>
          <span>•</span>
          <a href="${escapeHtml(prop.uri || '#')}" target="_blank" rel="noopener" class="text-blue-600 hover:underline">
            <i class="fas fa-external-link-alt mr-1"></i>Ver detalhes
          </a>
        </div>
      </div>`).join('') + `
      ${temMais ? `
        <div class="text-center mt-4">
          <button onclick="buscarProposicoes(${propState.pagina + 1})"
                  class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm">
            <i class="fas fa-plus mr-1"></i>Carregar mais
          </button>
        </div>` : ''}`;
  } catch (err) {
    if (isStale(ns, seq)) return;
    setLoading(loading, false);
    console.error('buscarProposicoes:', err);
    renderMessage(results, 'error', 'Erro ao buscar proposições: ' + escapeHtml(err.message));
  }
}

function exportarProposicoesCSV() {
  const linhas = propState.itens.map((p) => [p.id, p.siglaTipo, p.numero, p.ano, p.ementa, p.uri]);
  exportarCSV('proposicoes.csv', [['ID', 'Tipo', 'Número', 'Ano', 'Ementa', 'URI'], ...linhas]);
}

/* ------------------------------- Votações --------------------------------- */

const votState = { pagina: 1, ultimaPagina: Infinity, itens: [] };
const votosState = { titulo: '', votos: [], texto: '', tipo: '', partido: '' };

async function buscarVotacoes(pagina = 1) {
  const ns = 'votacoes';
  const seq = beginReq(ns);
  const ano = $('#votacao-ano')?.value.trim();
  const loading = $('#loading-votacoes');
  const results = $('#results-votacoes');

  if (pagina === 1) {
    votState.itens = [];
    votState.ultimaPagina = Infinity;
    results.innerHTML = '';
    hideChart('chart-votacoes-wrap');
  }

  setLoading(loading, true);

  try {
    const data = await apiGet('/camara/votacoes', { ano, pagina });
    if (isStale(ns, seq)) return;
    const novas = data.dados ?? [];
    extrairUltimaPagina(data, votState);
    votState.pagina = pagina;
    votState.itens.push(...novas);
    setLoading(loading, false);

    if (!votState.itens.length) {
      hideChart('chart-votacoes-wrap');
      return renderMessage(results, 'empty', 'Nenhuma votação encontrada para o ano informado.');
    }
    renderVotacoes(results);
  } catch (err) {
    if (isStale(ns, seq)) return;
    setLoading(loading, false);
    console.error('buscarVotacoes:', err);
    renderMessage(results, 'error', 'Erro ao buscar votações: ' + escapeHtml(err.message));
  }
}

function votacoesFiltradas() {
  const res = $('#votacao-filtro')?.value ?? '';
  const mes = $('#votacao-mes')?.value ?? '';
  const txt = ($('#votacao-texto')?.value ?? '').trim().toLowerCase();
  return votState.itens.filter((v) => {
    // aprovacao pode vir 1, 0, "1", "0" ou ausente.
    if (res !== '' && String(Number(v.aprovacao)) !== res) return false;
    if (mes && String(v.dataHoraRegistro || '').slice(5, 7) !== mes.padStart(2, '0')) return false;
    if (txt && !(`${v.titulo || ''} ${v.descricao || ''}`.toLowerCase().includes(txt))) return false;
    return true;
  });
}

function badgeResultado(vot) {
  const a = Number(vot.aprovacao);
  if (a === 1) return `<span class="text-xs px-2 py-1 rounded shrink-0 bg-green-100 text-green-800"><i class="fas fa-check mr-1"></i>Aprovada</span>`;
  if (a === 0) return `<span class="text-xs px-2 py-1 rounded shrink-0 bg-red-100 text-red-800"><i class="fas fa-times mr-1"></i>Rejeitada</span>`;
  return `<span class="text-xs px-2 py-1 rounded shrink-0 bg-gray-100 text-gray-600"><i class="fas fa-minus mr-1"></i>Sem resultado</span>`;
}

function renderVotacoes(results) {
  const exibidas = votacoesFiltradas();
  const temMais = votState.pagina < votState.ultimaPagina;

  // Gráfico-resumo das votações carregadas
  const nAprov = votState.itens.filter((v) => Number(v.aprovacao) === 1).length;
  const nRej = votState.itens.filter((v) => Number(v.aprovacao) === 0).length;
  const nSem = votState.itens.length - nAprov - nRej;
  if (votState.itens.length) {
    renderChart('chart-votacoes-wrap', 'chart-votacoes-resumo', doughConfig(
      ['Aprovadas', 'Rejeitadas', 'Sem resultado'],
      [nAprov, nRej, nSem],
      ['#16a34a', '#dc2626', '#9ca3af'],
      { plugins: { legend: { position: 'right' }, title: { display: true, text: `Resultado das ${votState.itens.length} votações carregadas` } } }
    ));
  }

  if (!exibidas.length) {
    return renderMessage(results, 'info', 'Nenhuma votação corresponde aos filtros selecionados.');
  }

  results.innerHTML = `
    <div class="mb-4 text-sm text-gray-600 flex flex-wrap items-center gap-3">
      <span><i class="fas fa-info-circle mr-2"></i>${exibidas.length} votação(ões) exibida(s) de ${votState.itens.length} carregada(s)</span>
      <button onclick="exportarVotacoesCSV()" class="text-xs border border-gray-300 px-3 py-1 rounded-lg hover:bg-gray-50">
        <i class="fas fa-file-csv mr-1"></i>Exportar lista CSV
      </button>
    </div>
  ` + exibidas.map((vot) => `
    <div class="result-item bg-white p-4 rounded-xl border border-gray-200">
      <div class="flex items-start justify-between mb-2 gap-2">
        <h3 class="font-semibold">${escapeHtml(vot.titulo || 'Votação sem título')}</h3>
        ${badgeResultado(vot)}
      </div>
      <p class="text-sm text-gray-600 mb-2">${escapeHtml(vot.descricao || 'Sem descrição')}</p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
        <span><i class="far fa-calendar mr-1"></i>${fmtDateTimeBR(vot.dataHoraRegistro)}</span>
        <span>•</span>
        <span class="text-gray-600">ID: ${vot.id}</span>

        <button
          onclick="verVotos(this.dataset.id, this.dataset.titulo, this.dataset.uri)"
          data-id="${escapeHtml(String(vot.id || ''))}"
          data-titulo="${escapeHtml(vot.titulo || 'Votação')}"
          data-uri="${escapeHtml(vot.uri || '')}"
          class="ml-2 text-xs bg-blue-600 text-white px-3 py-1 rounded-lg hover:bg-blue-700">
          <i class="fas fa-chart-pie mr-1"></i>Consultar votos
        </button>

        <a href="${escapeHtml(vot.uri || '#')}" target="_blank" rel="noopener" class="text-blue-600 hover:underline ml-2">
          <i class="fas fa-external-link-alt mr-1"></i>Ver detalhes
        </a>
      </div>
    </div>`).join('') + `
    ${temMais ? `
      <div class="text-center mt-4">
        <button onclick="buscarVotacoes(${votState.pagina + 1})"
                class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm">
          <i class="fas fa-plus mr-1"></i>Carregar mais
        </button>
      </div>` : ''}`;
}


function exportarVotacoesCSV() {
  const linhas = votacoesFiltradas().map((v) => {
    const a = Number(v.aprovacao);
    return [v.id, fmtDateTimeBR(v.dataHoraRegistro), v.titulo, v.descricao,
            a === 1 ? 'Aprovada' : a === 0 ? 'Rejeitada' : 'Sem resultado'];
  });
  exportarCSV('votacoes.csv', [['ID', 'Data/Hora', 'Título', 'Descrição', 'Resultado'], ...linhas]);
}

/* ------------------------- Modal de votos + gráficos ---------------------- */

function fecharModalVotos() {
  document.getElementById('modal-votos')?.remove();
  document.removeEventListener('keydown', escFechaModal);
}
const escFechaModal = (e) => { if (e.key === 'Escape') fecharModalVotos(); };

function abrirModal(titulo, bodyHtml) {
  fecharModalVotos();
  const modal = document.createElement('div');
  modal.id = 'modal-votos';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4';
  modal.innerHTML = `
    <div class="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6">
      <div class="flex items-start justify-between gap-4 mb-4">
        <h3 class="text-lg font-semibold">${escapeHtml(titulo)}</h3>
        <button onclick="fecharModalVotos()" aria-label="Fechar" class="text-gray-400 hover:text-gray-700 text-2xl leading-none">&times;</button>
      </div>
      <div id="modal-body">${bodyHtml}</div>
    </div>`;
  modal.addEventListener('click', (e) => { if (e.target === modal) fecharModalVotos(); });
  document.addEventListener('keydown', escFechaModal);
  document.body.appendChild(modal);
}

const normalizarVoto = (v) => {
  const s = String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (s === 'sim') return 'Sim';
  if (s === 'nao') return 'Não';
  if (s.includes('absten')) return 'Abstenção';
  if (s.includes('obstru')) return 'Obstrução';
  return 'Outros';
};

function votosFiltrados() {
  const t = votosState.texto.trim().toLowerCase();
  return votosState.votos.filter((v) => {
    if (votosState.tipo && normalizarVoto(v.voto) !== votosState.tipo) return false;
    if (votosState.partido && (v.partido || '') !== votosState.partido) return false;
    if (t && !(v.nome || '').toLowerCase().includes(t)) return false;
    return true;
  });
}

function renderTabelaVotos() {
  const corpo = document.getElementById('votos-tbody');
  const contagem = document.getElementById('votos-contagem');
  if (!corpo) return;
  const filtrados = votosFiltrados();
  const coresVoto = { 'Sim': '#16a34a', 'Não': '#dc2626', 'Abstenção': '#f59e0b', 'Obstrução': '#7c3aed', 'Outros': '#9ca3af' };
  corpo.innerHTML = filtrados.map((v) => {
    const nv = normalizarVoto(v.voto);
    return `
      <tr class="border-t border-gray-100">
        <td class="px-3 py-2">${escapeHtml(v.nome || '—')}</td>
        <td class="px-3 py-2 text-gray-600">${escapeHtml(v.partido || '—')}</td>
        <td class="px-3 py-2 text-gray-600">${escapeHtml(v.uf || '—')}</td>
        <td class="px-3 py-2"><span class="px-2 py-0.5 rounded" style="background:${coresVoto[nv]}22;color:${coresVoto[nv]}">${escapeHtml(v.voto || '—')}</span></td>
      </tr>`;
  }).join('') || `<tr><td colspan="4" class="px-3 py-6 text-center text-gray-400">Nenhum voto corresponde aos filtros.</td></tr>`;
  if (contagem) contagem.textContent = `${filtrados.length} de ${votosState.votos.length} votos`;
}

async function verVotos(votacaoId, titulo, uri = '') {
  const id = String(votacaoId ?? '').trim();

  abrirModal(
    titulo || `Votação ${id}`,
    `
      <div class="text-center py-8 text-gray-500">
        <i class="fas fa-spinner fa-spin text-2xl text-blue-600"></i>
        <p class="mt-3">Consultando votos individuais...</p>
        <p class="text-xs mt-1">ID da votação: ${escapeHtml(id)}</p>
      </div>
    `
  );

  try {
    console.log('[VOTOS] ID enviado:', id);

    const data = await apiGet(
      `/camara/votacoes/${encodeURIComponent(id)}/votos`
    );

    console.log('[VOTOS] Resposta recebida:', data);

    const votos = Array.isArray(data?.dados) ? data.dados : [];

    console.log('[VOTOS] Quantidade recebida:', votos.length);

    if (!votos.length) {
      document.getElementById('modal-body').innerHTML = `
        <div class="text-center py-8">
          <div class="mx-auto mb-4 w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center">
            <i class="fas fa-info-circle text-2xl text-gray-400"></i>
          </div>

          <h4 class="text-lg font-semibold text-gray-700 mb-2">
            Votos individuais não disponíveis
          </h4>

          <p class="text-sm text-gray-500 max-w-lg mx-auto leading-relaxed">
            A Câmara dos Deputados não disponibilizou registros de votos
            individuais para esta votação.
          </p>

          <div class="mt-4 inline-flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-4 py-2 text-xs text-gray-500">
            <i class="fas fa-hashtag"></i>
            <span>ID da votação: <strong>${escapeHtml(id)}</strong></span>
          </div>

          ${
            uri
              ? `
                <div class="mt-5">
                  <a href="${escapeHtml(uri)}"
                     target="_blank"
                     rel="noopener"
                     class="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm">
                    <i class="fas fa-external-link-alt"></i>
                    Ver votação oficial na Câmara
                  </a>
                </div>
              `
              : ''
          }

          <p class="text-xs text-gray-400 mt-5">
            Isso não significa que houve erro na consulta.
          </p>
        </div>
      `;
      return;
    }

    votosState.titulo = titulo || `Votação ${id}`;
    votosState.votos = votos;
    votosState.texto = '';
    votosState.tipo = '';
    votosState.partido = '';

    const geral = {};

    votos.forEach((v) => {
      const n = normalizarVoto(v.voto);
      geral[n] = (geral[n] || 0) + 1;
    });

    const porPartido = {};

    votos.forEach((v) => {
      const p = v.partido || '—';
      const n = normalizarVoto(v.voto);

      porPartido[p] ??= {
        Sim: 0,
        'Não': 0
      };

      if (porPartido[p][n] !== undefined) {
        porPartido[p][n]++;
      }
    });

    const topPartidos = Object.entries(porPartido)
      .sort(
        (a, b) =>
          (b[1].Sim + b[1]['Não']) -
          (a[1].Sim + a[1]['Não'])
      )
      .slice(0, 8);

    const partidos = [
      ...new Set(
        votos
          .map((v) => v.partido)
          .filter(Boolean)
      )
    ].sort();

    const coresVoto = {
      'Sim': '#16a34a',
      'Não': '#dc2626',
      'Abstenção': '#f59e0b',
      'Obstrução': '#7c3aed',
      'Outros': '#9ca3af'
    };

    document.getElementById('modal-body').innerHTML = `
      <div class="space-y-5">

        <div class="grid grid-cols-2 md:grid-cols-5 gap-3">

          ${Object.entries(geral).map(([tipo, quantidade]) => `
            <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
              <div class="text-xs text-gray-500">${escapeHtml(tipo)}</div>
              <div class="text-xl font-bold mt-1">${quantidade}</div>
            </div>
          `).join('')}

        </div>

        <div class="flex flex-wrap gap-2 items-center">

          <input
            id="votos-filtro-texto"
            type="text"
            placeholder="Pesquisar deputado..."
            class="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]"
          >

          <select
            id="votos-filtro-tipo"
            class="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Todos os votos</option>
            <option value="Sim">Sim</option>
            <option value="Não">Não</option>
            <option value="Abstenção">Abstenção</option>
            <option value="Obstrução">Obstrução</option>
            <option value="Outros">Outros</option>
          </select>

          <select
            id="votos-filtro-partido"
            class="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Todos os partidos</option>
            ${partidos.map((p) => `
              <option value="${escapeHtml(p)}">${escapeHtml(p)}</option>
            `).join('')}
          </select>

          <button
            onclick="exportarVotosCSV()"
            class="border border-gray-300 px-3 py-2 rounded-lg hover:bg-gray-50 text-sm"
          >
            <i class="fas fa-file-csv mr-1"></i>
            Exportar CSV
          </button>

        </div>

        <div class="text-sm font-medium text-gray-600">
          <span id="votos-contagem">${votos.length} votos</span>
        </div>

        <div class="overflow-x-auto border border-gray-200 rounded-lg">
          <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
              <tr>
                <th class="text-left px-3 py-2">Deputado</th>
                <th class="text-left px-3 py-2">Partido</th>
                <th class="text-left px-3 py-2">UF</th>
                <th class="text-left px-3 py-2">Voto</th>
              </tr>
            </thead>

            <tbody id="votos-tbody"></tbody>
          </table>
        </div>

      </div>
    `;

    const campoTexto = document.getElementById('votos-filtro-texto');
    const campoTipo = document.getElementById('votos-filtro-tipo');
    const campoPartido = document.getElementById('votos-filtro-partido');

    campoTexto?.addEventListener('input', (e) => {
      votosState.texto = e.target.value;
      renderTabelaVotos();
    });

    campoTipo?.addEventListener('change', (e) => {
      votosState.tipo = e.target.value;
      renderTabelaVotos();
    });

    campoPartido?.addEventListener('change', (e) => {
      votosState.partido = e.target.value;
      renderTabelaVotos();
    });

    renderTabelaVotos();

  } catch (err) {
    console.error('[VOTOS] Erro:', err);

    document.getElementById('modal-body').innerHTML = `
      <div class="text-center py-8">

        <div class="mx-auto mb-4 w-14 h-14 rounded-full bg-red-100 flex items-center justify-center">
          <i class="fas fa-exclamation-triangle text-2xl text-red-500"></i>
        </div>

        <h4 class="text-lg font-semibold text-red-700 mb-2">
          Não foi possível consultar os votos
        </h4>

        <p class="text-sm text-gray-600 max-w-lg mx-auto">
          Ocorreu um erro durante a consulta dos votos individuais.
        </p>

        <p class="text-xs text-gray-400 mt-3">
          ID da votação: ${escapeHtml(id)}
        </p>

        <p class="text-xs text-red-500 mt-2">
          ${escapeHtml(err?.message || 'Erro desconhecido')}
        </p>

      </div>
    `;
  }
}


function exportarVotosCSV() {
  const linhas = votosFiltrados().map((v) => [v.nome, v.partido, v.uf, v.voto]);
  exportarCSV(`votos_${votosState.titulo.replace(/[^\w]+/g, '_').slice(0, 40)}.csv`,
    [['Deputado', 'Partido', 'UF', 'Voto'], ...linhas]);
}

/* ================================ SENADO ================================== */

let senadoresCache = [];

async function buscarSenadores() {
  const ns = 'senadores';
  const seq = beginReq(ns);
  const uf = $('#senador-uf')?.value.trim().toUpperCase();
  const partido = $('#senador-partido')?.value.trim().toUpperCase();
  const loading = $('#loading-senadores');
  const results = $('#results-senadores');

  setLoading(loading, true);
  results.innerHTML = '';

  try {
    const data = await apiGet('/senado/senadores', { uf, partido });
    if (isStale(ns, seq)) return;
    let senadores = data.senadores ?? [];
    if (partido) senadores = senadores.filter((s) => (s.partido || '').toUpperCase() === partido);
    senadoresCache = data.senadores ?? [];

    setLoading(loading, false);
    if (!senadores.length) {
      hideChart('chart-senadores-wrap');
      return renderMessage(results, 'empty', 'Nenhum senador encontrado');
    }

    results.innerHTML = `
      <div class="mb-4 text-sm text-gray-600 flex flex-wrap items-center gap-3">
        <span><i class="fas fa-info-circle mr-2"></i>${senadores.length} senador(es) em exercício</span>
        <button onclick="exportarSenadoresCSV()" class="text-xs border border-gray-300 px-3 py-1 rounded-lg hover:bg-gray-50">
          <i class="fas fa-file-csv mr-1"></i>Exportar CSV
        </button>
      </div>
    ` + senadores.map((s) => `
      <div class="result-item bg-white border rounded-xl p-4 flex gap-4">
        <img src="${escapeHtml(s.foto || '')}" alt="${escapeHtml(s.nome)}"
             class="w-16 h-16 rounded-full object-cover bg-gray-100 shrink-0"
             onerror="this.style.visibility='hidden'">
        <div class="flex-1 min-w-0">
          <h3 class="text-lg font-bold">${escapeHtml(s.nome)}</h3>
          <p class="text-sm text-gray-600">${escapeHtml(s.partido || '—')} - ${escapeHtml(s.uf || '—')}</p>
          ${s.email ? `<p class="text-xs text-gray-400 mt-1"><i class="far fa-envelope mr-1"></i>${escapeHtml(s.email)}</p>` : ''}
          ${s.pagina ? `<a href="${escapeHtml(s.pagina)}" target="_blank" rel="noopener" class="text-xs text-emerald-600 hover:underline"><i class="fas fa-external-link-alt mr-1"></i>Página no Senado</a>` : ''}
        </div>
      </div>`).join('');

    const contagem = {};
    senadores.forEach((s) => { const p = s.partido || '—'; contagem[p] = (contagem[p] || 0) + 1; });
    const top = Object.entries(contagem).sort((a, b) => b[1] - a[1]).slice(0, 10);
    renderChart('chart-senadores-wrap', 'chart-senadores',
      barConfig(top.map(([p]) => p), top.map(([, n]) => n), 'Senadores por partido', '#059669'));
  } catch (err) {
    if (isStale(ns, seq)) return;
    setLoading(loading, false);
    console.error('buscarSenadores:', err);
    renderMessage(results, 'error', 'Erro ao buscar senadores: ' + escapeHtml(err.message));
  }
}

function exportarSenadoresCSV() {
  const linhas = senadoresCache.map((s) => [s.nome, s.partido, s.uf, s.email, s.pagina]);
  exportarCSV('senadores.csv', [['Nome', 'Partido', 'UF', 'E-mail', 'Página'], ...linhas]);
}

/* ------------------------------- Matérias --------------------------------- */

const matState = { itens: [], situacoesCache: '' };

async function buscarMaterias() {
  const ns = 'materias';
  const seq = beginReq(ns);
  const tipo = $('#materia-tipo')?.value.trim().toUpperCase();
  const ano  = $('#materia-ano')?.value.trim();
  const loading = $('#loading-materias');
  const results = $('#results-materias');

  setLoading(loading, true);
  results.innerHTML = '';

  try {
    const data = await apiGet('/senado/materias', { tipo, ano });
    if (isStale(ns, seq)) return;
    matState.itens = data.materias ?? [];
    setLoading(loading, false);
    renderMaterias(results);
  } catch (err) {
    if (isStale(ns, seq)) return;
    setLoading(loading, false);
    console.error('buscarMaterias:', err);
    renderMessage(results, 'error', 'Erro ao buscar matérias: ' + escapeHtml(err.message));
  }
}

function renderMaterias(results) {
  const itens = matState.itens;
  if (!itens.length) {
    return renderMessage(results, 'empty', 'Nenhuma matéria encontrada para os filtros informados.');
  }

  // Preenche o select de situações somente quando o conjunto muda
  const situacoes = [...new Set(itens.map((m) => m.situacao).filter(Boolean))].sort();
  const chave = situacoes.join('|');
  const selSit = $('#materia-situacao');
  if (selSit && chave !== matState.situacoesCache) {
    matState.situacoesCache = chave;
    const atual = selSit.value;
    selSit.innerHTML = `<option value="">Todas as situações</option>` +
      situacoes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    selSit.value = situacoes.includes(atual) ? atual : '';
  }

  const txt = ($('#materia-filtro')?.value ?? '').trim().toLowerCase();
  const sit = $('#materia-situacao')?.value ?? '';
  const filtradas = itens.filter((m) => {
    if (sit && (m.situacao || '') !== sit) return false;
    if (txt && !(`${m.sigla || ''} ${m.numero || ''} ${m.ementa || ''}`.toLowerCase().includes(txt))) return false;
    return true;
  });

  const LIMITE = 100;
  results.innerHTML = `
    <div class="mb-4 text-sm text-gray-600 flex flex-wrap items-center gap-3">
      <span><i class="fas fa-info-circle mr-2"></i>${filtradas.length} matéria(s)${filtradas.length !== itens.length ? ` (de ${itens.length})` : ''}
        ${filtradas.length > LIMITE ? `· mostrando as primeiras ${LIMITE}` : ''}</span>
      ${filtradas.length ? `
      <button onclick="exportarMateriasCSV()" class="text-xs border border-gray-300 px-3 py-1 rounded-lg hover:bg-gray-50">
        <i class="fas fa-file-csv mr-1"></i>Exportar CSV
      </button>` : ''}
    </div>
  ` + (filtradas.length ? filtradas.slice(0, LIMITE).map((m) => `
    <div class="result-item bg-white p-4 rounded-xl border border-gray-200">
      <div class="flex items-start justify-between mb-2 gap-2">
        <h3 class="font-semibold">${escapeHtml(m.sigla || '')} ${escapeHtml(m.numero)}/${escapeHtml(m.ano)}</h3>
        ${m.situacao ? `<span class="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded shrink-0">${escapeHtml(m.situacao)}</span>` : ''}
      </div>
      <p class="text-sm text-gray-700 mb-2">${escapeHtml(m.ementa || 'Sem ementa disponível')}</p>
      <div class="flex items-center space-x-2 text-xs text-gray-500">
        ${m.dataApresent ? `<span><i class="far fa-calendar mr-1"></i>${fmtDateBR(m.dataApresent)}</span><span>•</span>` : ''}
        ${m.urlDetalhe || m.codigo ? `
          <a href="${escapeHtml(m.urlDetalhe || `https://www25.senado.leg.br/web/atividade/materias/-/materia/${m.codigo}`)}"
             target="_blank" rel="noopener" class="text-emerald-600 hover:underline">
            <i class="fas fa-external-link-alt mr-1"></i>Ver detalhes
          </a>` : ''}
      </div>
    </div>`).join('') : `
    <div class="text-center py-6 text-gray-500"><i class="fas fa-filter text-2xl mb-2 block"></i>Nenhuma matéria corresponde aos filtros.</div>`);
}

function exportarMateriasCSV() {
  const txt = ($('#materia-filtro')?.value ?? '').trim().toLowerCase();
  const sit = $('#materia-situacao')?.value ?? '';
  const linhas = matState.itens
    .filter((m) => {
      if (sit && (m.situacao || '') !== sit) return false;
      if (txt && !(`${m.sigla || ''} ${m.numero || ''} ${m.ementa || ''}`.toLowerCase().includes(txt))) return false;
      return true;
    })
    .map((m) => [m.codigo, `${m.sigla || ''} ${m.numero || ''}/${m.ano || ''}`, m.ementa, m.situacao, m.dataApresent]);
  exportarCSV('materias_senado.csv', [['Código', 'Matéria', 'Ementa', 'Situação', 'Apresentação'], ...linhas]);
}

/* --------------------- Despesas Senado (CEAPS) --------------------------- */

const senadoDespState = { ano: null, senador: '', mes: '', despesas: [] };

async function buscarDespesasSenado() {
  const ns = 'senadoDespesas';
  const seq = beginReq(ns);
  const ano     = $('#senado-despesa-ano')?.value.trim();
  const senador = $('#senado-despesa-senador')?.value.trim();
  const mes     = $('#senado-despesa-mes')?.value.trim();
  const loading = $('#loading-senado-despesas');
  const results = $('#results-senado-despesas');

  if (!ano) return renderMessage(results, 'info', 'Selecione o ano.');

  senadoDespState.ano = ano;
  senadoDespState.senador = senador;
  senadoDespState.mes = mes;
  senadoDespState.despesas = [];

  setLoading(loading, true);
  results.innerHTML = '';
  hideChart('chart-senado-ranking-wrap');
  hideChart('chart-senado-despesas-wrap');

  try {
    const data = await apiGet('/senado/despesas', { ano, senador, mes });
    if (isStale(ns, seq)) return;
    setLoading(loading, false);

    if (!data.quantidade) {
      return renderMessage(results, 'empty', 'Nenhuma despesa encontrada para os filtros informados.');
    }
    senadoDespState.despesas = data.despesas ?? [];
    renderDespesasSenado(data, results);
  } catch (err) {
    if (isStale(ns, seq)) return;
    setLoading(loading, false);
    console.error('buscarDespesasSenado:', err);
    renderMessage(results, 'error', 'Erro ao buscar despesas (CEAPS): ' + escapeHtml(err.message));
  }
}

function renderDespesasSenado(data, results) {
  const porTipo = (data.porTipo ?? []).slice(0, 8);
  const porMes  = (data.porMes ?? []).slice(-12);
  const porSen  = (data.porSenador ?? []).slice(0, 10);

  if (!data.senador && porSen.length) {
    renderChart('chart-senado-ranking-wrap', 'chart-senado-ranking', {
      type: 'bar',
      data: {
        labels: porSen.map((s) => s.senador),
        datasets: [{ label: 'Total gasto', data: porSen.map((s) => s.valor), backgroundColor: '#059669', borderRadius: 6 }],
      },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${fmtBRL(ctx.parsed.x)}` } } },
        scales: { x: { beginAtZero: true } },
      },
    });
  } else {
    hideChart('chart-senado-ranking-wrap');
  }

  if (porTipo.length) {
    renderChart('chart-senado-despesas-wrap', 'chart-senado-tipo', {
      type: 'doughnut',
      data: { labels: porTipo.map((t) => t.tipo), datasets: [{ data: porTipo.map((t) => t.valor), backgroundColor: PALETA, borderWidth: 1 }] },
      options: {
        plugins: {
          legend: { position: 'right' },
          tooltip: { callbacks: { label: (ctx) => ` ${fmtBRL(ctx.parsed)}` } },
        },
      },
    });
    renderChart('chart-senado-despesas-wrap', 'chart-senado-mes', {
      type: 'bar',
      data: {
        labels: porMes.map((m) => m.mes),
        datasets: [{ label: 'Valor', data: porMes.map((m) => m.valor), backgroundColor: '#0891b2', borderRadius: 6 }],
      },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${fmtBRL(ctx.parsed.y)}` } } }, scales: { y: { beginAtZero: true } } },
    });
  }

  const despesas = data.despesas ?? [];
  results.innerHTML = `
    <div class="bg-white border border-gray-200 rounded-xl p-4 mb-4">
      <p class="text-sm text-gray-600">
        <i class="fas fa-calculator mr-1"></i>${data.quantidade} lançamento(s) · ano ${escapeHtml(data.ano)}
        ${data.senador ? ` — <strong>${escapeHtml(data.senador)}</strong>` : ''}
        ${data.mes ? ` · mês ${escapeHtml(data.mes)}` : ''}
      </p>
      <p class="text-lg font-semibold mt-1">Total: ${fmtBRL(data.total)}</p>
      ${despesas.length ? `
        <button onclick="exportarDespesasSenadoCSV()" class="mt-2 text-xs border border-gray-300 px-3 py-1 rounded-lg hover:bg-gray-50">
          <i class="fas fa-file-csv mr-1"></i>Exportar CSV
        </button>` : `
        <p class="text-xs text-gray-500 mt-1">Selecione um senador para ver o detalhe nota a nota (o ranking geral está no gráfico acima).</p>`}
    </div>
  ` + despesas.slice(0, 300).map((d) => `
    <div class="result-item bg-white p-4 rounded-xl border border-gray-200">
      <h3 class="font-semibold">${escapeHtml(d.senador)} — ${fmtBRL(d.valor)}</h3>
      <p class="text-sm text-gray-600 mt-1">
        <span class="inline-block bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded mr-2 mb-1">${escapeHtml(d.tipo || 'Tipo não informado')}</span>
        <span class="inline-block bg-gray-100 px-2 py-0.5 rounded mr-2 mb-1">${escapeHtml(d.mes)}/${escapeHtml(d.ano)}</span>
        ${d.data ? `<span class="inline-block bg-gray-100 px-2 py-0.5 rounded mb-1">${fmtDateBR(d.data)}</span>` : ''}
      </p>
      <p class="text-sm text-gray-600 mt-1">
        <span class="inline-block bg-gray-100 px-2 py-0.5 rounded mr-2 mb-1">CNPJ/CPF: ${escapeHtml(d.cnpjCpf || '—')}</span>
        <span class="inline-block bg-gray-100 px-2 py-0.5 rounded mb-1">Fornecedor: ${escapeHtml(d.fornecedor || '—')}</span>
      </p>
      ${d.documento ? `<p class="text-xs text-gray-500 mt-1">Documento: ${escapeHtml(d.documento)}</p>` : ''}
    </div>`).join('') + (despesas.length > 300 ?
      `<p class="text-center text-xs text-gray-500 mt-3">Exibindo 300 de ${despesas.length} lançamentos — use o CSV para o completo.</p>` : '');
}

function exportarDespesasSenadoCSV() {
  const header = ['Ano', 'Mês', 'Senador', 'Tipo Despesa', 'CNPJ/CPF', 'Fornecedor', 'Documento', 'Data', 'Valor'];
  const linhas = senadoDespState.despesas.map((d) => [
    d.ano, d.mes, d.senador, d.tipo, d.cnpjCpf, d.fornecedor, d.documento, d.data,
    String(d.valor ?? '').replace('.', ','),
  ]);
  exportarCSV(`ceaps_senado_${senadoDespState.ano}.csv`, [header, ...linhas]);
}

/* ------------------------------- Inicialização ---------------------------- */

function popularSelectAnos(selectId, anoInicial = 2021, incluirTodos = false) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const anoAtual = new Date().getFullYear();
  sel.innerHTML = (incluirTodos ? `<option value="">Todos os anos</option>` : '') +
    Array.from({ length: anoAtual - anoInicial + 1 }, (_, i) => anoAtual - i)
      .map((a) => `<option value="${a}">${a}</option>`).join('');
  sel.value = anoAtual;
}

async function popularPartidos() {
  const dl = $('#lista-partidos');
  if (!dl) return;
  try {
    const data = await apiGet('/camara/partidos', { itens: 100 });
    dl.innerHTML = (data.dados ?? []).map((p) => `<option value="${escapeHtml(p.sigla)}">`).join('');
  } catch (err) { console.warn('popularPartidos:', err); }
}

/** Preenche o datalist de senadores para a aba CEAPS. */
async function popularSenadores() {
  const dl = $('#lista-senadores');
  if (!dl) return;
  try {
    const data = await apiGet('/senado/senadores', {});
    senadoresCache = data.senadores ?? [];
    dl.innerHTML = senadoresCache.map((s) => `<option value="${escapeHtml(s.nome)}">`).join('');
  } catch (err) { console.warn('popularSenadores:', err); }
}

function init() {
  const anoAtual = new Date().getFullYear();
  ['proposicao-ano', 'materia-ano'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = anoAtual;
  });
  popularSelectAnos('despesa-ano', 2021, true);
  popularSelectAnos('senado-despesa-ano', 2008, false);
  popularSelectAnos('votacao-ano', 2019, false);
  popularPartidos();
  popularSenadores();
  renderCEAPRecentes();

  bindEnter('deputado-nome', buscarDeputados);
  bindEnter('deputado-partido', buscarDeputados);
  bindEnter('deputado-uf', buscarDeputados);
  bindEnter('deputado-codigo', () => buscarDespesasDeputados(1));
  bindEnter('proposicao-termo', () => buscarProposicoes(1));
  bindEnter('senador-uf', buscarSenadores);
  bindEnter('senador-partido', buscarSenadores);
  bindEnter('senado-despesa-senador', buscarDespesasSenado);

  const auto = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', debounce(fn, 500));
  };
  auto('deputado-nome', buscarDeputados);
  auto('proposicao-termo', () => buscarProposicoes(1));

  // NOVO: trocar ano/mês na CEAP re-busca automaticamente quando o código
  // já está preenchido e já existe uma lista carregada.
  ['despesa-ano', 'despesa-mes'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      const codigo = ($('#deputado-codigo')?.value || '').trim();
      if (codigo && despesasState.itens.length) buscarDespesasDeputados(1);
    });
  });

  // Re-renderiza sem nova busca ao mexer nos filtros client-side
  $('#votacao-filtro')?.addEventListener('change', () => {
    if (votState.itens.length) renderVotacoes($('#results-votacoes'));
  });
  $('#votacao-mes')?.addEventListener('change', () => {
    if (votState.itens.length) renderVotacoes($('#results-votacoes'));
  });
  $('#votacao-texto')?.addEventListener('input', debounce(() => {
    if (votState.itens.length) renderVotacoes($('#results-votacoes'));
  }, 250));

  $('#despesa-filtro')?.addEventListener('input', debounce((e) => {
    despesasFilter.texto = e.target.value;
    if (despesasState.itens.length) renderDespesas($('#results-despesas'));
  }, 250));
  $('#despesa-ordenar')?.addEventListener('change', (e) => {
    despesasFilter.ordenar = e.target.value;
    if (despesasState.itens.length) renderDespesas($('#results-despesas'));
  });

  $('#materia-filtro')?.addEventListener('input', debounce(() => {
    if (matState.itens.length) renderMaterias($('#results-materias'));
  }, 250));
  $('#materia-situacao')?.addEventListener('change', () => {
    if (matState.itens.length) renderMaterias($('#results-materias'));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
