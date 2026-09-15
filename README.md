# Portal Legislativo Brasileiro

## Visão Geral do Projeto

Portal web para pesquisar e consultar dados públicos da Câmara dos Deputados e Senado Federal através de suas APIs oficiais de Dados Abertos.

## URLs

- **Aplicação em Produção (Sandbox)**: https://3000-it602la5hs3b3thr7tkn0-5185f4aa.sandbox.novita.ai
- **API Câmara dos Deputados**: https://dadosabertos.camara.leg.br/
- **API Senado Federal**: https://legis.senado.leg.br/dadosabertos/

## Funcionalidades Implementadas

### ✅ Câmara dos Deputados
1. **Busca de Deputados**
   - Filtros: Nome, Partido, UF
   - Exibe: Foto, nome, partido, estado, email e ID
   - Endpoint: `/api/camara/deputados`

2. **Busca de Proposições**
   - Filtros: Termo de busca, Ano
   - Exibe: Tipo, número, ementa, ano e link para detalhes
   - Limite: 50 resultados por busca
   - Endpoint: `/api/camara/proposicoes`

3. **Busca de Votações**
   - Filtros: Ano
   - Exibe: Título, descrição, data/hora, resultado e link
   - Limite: 30 resultados por busca
   - Endpoint: `/api/camara/votacoes`

### ⚠️ Senado Federal (Em Desenvolvimento)
4. **Lista de Senadores**
   - Status: Interface preparada, aguarda processamento de XML
   - Endpoint: `/api/senado/senadores`

5. **Busca de Matérias Legislativas**
   - Status: Interface preparada, aguarda processamento de XML
   - Filtros: Tipo (PLS, PEC, PRS), Ano
   - Endpoint: `/api/senado/materias`

## Recursos Técnicos

### Frontend
- **Interface responsiva** com Tailwind CSS
- **Sistema de abas** para organização das pesquisas
- **Loading states** durante carregamento de dados
- **Tratamento de erros** com mensagens amigáveis
- **Ícones** via FontAwesome
- **HTTP Client**: Axios

### Backend
- **Framework**: Hono (Cloudflare Workers)
- **Rotas API RESTful** para proxy das APIs oficiais
- **CORS habilitado** para comunicação frontend-backend
- **Tratamento de erros** em todas as rotas

### Endpoints da API

#### Câmara dos Deputados
```
GET /api/camara/deputados?nome=João&partido=PT&uf=SP
GET /api/camara/proposicoes?termo=saúde&ano=2024
GET /api/camara/votacoes?ano=2024
```

#### Senado Federal
```
GET /api/senado/senadores
GET /api/senado/materias?tipo=PLS&ano=2024
```

## Arquitetura de Dados

### APIs Consumidas
- **Câmara dos Deputados API v2** (JSON)
  - Base URL: `https://dadosabertos.camara.leg.br/api/v2/`
  - Formato: JSON
  - Autenticação: Não requerida

- **Senado Federal Dados Abertos** (XML)
  - Base URL: `https://legis.senado.leg.br/dadosabertos/`
  - Formato: XML
  - Status: Requer parser XML para JSON

### Fluxo de Dados
```
[Frontend] → [Hono API Routes] → [APIs Oficiais] → [Resposta JSON] → [Renderização UI]
```

## Como Usar

### Buscar Deputados
1. Acesse a aba "Câmara - Deputados"
2. Preencha os filtros desejados (nome, partido, UF)
3. Clique em "Buscar Deputados"
4. Visualize os resultados com fotos e informações

### Buscar Proposições
1. Acesse a aba "Câmara - Proposições"
2. Digite palavras-chave e selecione o ano
3. Clique em "Buscar Proposições"
4. Visualize até 50 resultados com detalhes

### Buscar Votações
1. Acesse a aba "Câmara - Votações"
2. Selecione o ano desejado
3. Clique em "Buscar Votações"
4. Visualize até 30 votações mais recentes

## Stack Tecnológica

- **Runtime**: Cloudflare Workers
- **Framework**: Hono v4
- **Build Tool**: Vite
- **Deployment**: Cloudflare Pages
- **Estilo**: Tailwind CSS (CDN)
- **Ícones**: FontAwesome 6
- **HTTP Client**: Axios
- **Process Manager**: PM2 (desenvolvimento)

## Estrutura do Projeto

```
webapp/
├── src/
│   ├── index.tsx          # Aplicação principal Hono + HTML
│   └── renderer.tsx       # Renderer TSX (padrão Hono)
├── public/
│   └── static/
│       └── app.js         # JavaScript frontend
├── dist/                  # Build de produção
├── ecosystem.config.cjs   # Configuração PM2
├── wrangler.jsonc         # Configuração Cloudflare
├── vite.config.ts         # Configuração Vite
└── package.json           # Dependências e scripts
```

## Desenvolvimento Local

### Comandos Disponíveis

```bash
# Build do projeto
npm run build

# Desenvolvimento (sandbox)
npm run dev:sandbox

# Preview local
npm run preview

# Deploy na Cloudflare
npm run deploy

# Limpar porta 3000
npm run clean-port

# Testar aplicação
npm run test

# Git
npm run git:status
npm run git:commit -- "mensagem"
npm run git:log
```

### Iniciar Servidor de Desenvolvimento

```bash
# 1. Build
npm run build

# 2. Limpar porta (se necessário)
fuser -k 3000/tcp 2>/dev/null || true

# 3. Iniciar com PM2
pm2 start ecosystem.config.cjs

# 4. Verificar logs
pm2 logs webapp --nostream

# 5. Testar
curl http://localhost:3000
```

## Status do Deployment

- **Plataforma**: Cloudflare Pages
- **Status**: ✅ Executando em sandbox
- **Ambiente**: Desenvolvimento
- **URL**: https://3000-it602la5hs3b3thr7tkn0-5185f4aa.sandbox.novita.ai

## Próximos Passos Recomendados

### Alta Prioridade
1. **Parser XML para Senado**: Implementar conversão de XML para JSON nas rotas do Senado
2. **Deploy Produção**: Fazer deploy na Cloudflare Pages oficial
3. **Paginação**: Adicionar paginação para resultados extensos

### Média Prioridade
4. **Cache**: Implementar cache das requisições (Cloudflare KV)
5. **Filtros Avançados**: Mais opções de filtro nas buscas
6. **Detalhes**: Páginas de detalhes para deputados/senadores
7. **Exportação**: Exportar resultados em CSV/Excel

### Baixa Prioridade
8. **Gráficos**: Visualizações de dados com Chart.js
9. **Favoritos**: Sistema de favoritos (localStorage)
10. **Compartilhamento**: Compartilhar buscas via URL

## Desafios Técnicos

### API do Senado (XML)
- A API do Senado retorna dados em XML, não JSON
- É necessário implementar um parser XML para converter em JSON
- Alternativas:
  - Biblioteca `fast-xml-parser` no backend
  - Processar XML no frontend
  - Usar serviço de conversão

### Performance
- APIs oficiais podem ter latência variável
- Limitação de resultados implementada (30-50 itens)
- Considerar implementar cache para otimização

## Licença e Dados

Este projeto utiliza dados públicos disponibilizados pelas APIs oficiais:
- Câmara dos Deputados: Dados Abertos
- Senado Federal: Portal de Dados Abertos Legislativos

Os dados são de domínio público conforme Lei de Acesso à Informação (LAI).

## Contato e Suporte

Para questões sobre as APIs oficiais:
- Câmara: https://dadosabertos.camara.leg.br/howtouse.html
- Senado: https://legis.senado.leg.br/dadosabertos/

---

**Última Atualização**: 2024-11-19  
**Versão**: 1.0.0  
**Status**: Desenvolvimento Ativo
