# Como publicar esta Wiki no GitHub

> Este arquivo é só a instrução — **não** o publique como página da Wiki.

A Wiki do GitHub é um repositório Git separado, com o sufixo `.wiki.git`. As páginas desta pasta já estão no formato certo.

## 1. Criar a Wiki (só na primeira vez)

O repositório `.wiki.git` não existe até a primeira página ser criada pela interface:

1. Acesse `https://github.com/dudufritz/ihome-backend/wiki`
2. Clique em **Create the first page**
3. Salve com qualquer conteúdo — será sobrescrito no passo seguinte

> Se a aba Wiki não aparecer: **Settings → Features → marque Wikis**.

## 2. Publicar todas as páginas

```bash
cd ..                                   # sai da pasta do repositório
git clone https://github.com/dudufritz/ihome-backend.wiki.git
cd ihome-backend.wiki

# Copia as páginas, exceto esta instrução
cp ../ihome-backend/wiki/*.md .
rm -f PUBLICAR.md

git add .
git commit -m "docs: arquitetura, requisitos, decisões técnicas e deploy"
git push origin master        # a Wiki usa 'master', não 'main'
```

Pronto — as páginas ficam em `https://github.com/dudufritz/ihome-backend/wiki`.

## 3. Manter atualizada

`Arquitetura.md` e `Deploy.md` são cópias de `ARQUITETURA.md` e `DEPLOY.md` da raiz do repositório. Ao alterar os originais, sincronize:

```bash
cd ihome-backend/wiki
cp ../ARQUITETURA.md Arquitetura.md
cp ../DEPLOY.md Deploy.md
```

E repita o passo 2.

## Páginas

| Arquivo | Vira a página | Conteúdo |
|---|---|---|
| `Home.md` | Início da Wiki | Problema, solução, navegação |
| `Requisitos.md` | Requisitos | 29 requisitos funcionais, 20 não funcionais, 5 casos de uso |
| `Arquitetura.md` | Arquitetura | Camadas, modelo de dados, integrações |
| `Decisoes-Tecnicas.md` | Decisões Técnicas | 13 decisões com alternativas descartadas e limitações |
| `Deploy.md` | Deploy | Provisionamento no Azure e pipeline |
| `Contribuindo.md` | Contribuindo | Como rodar, padrões, fluxo de PR |
| `_Sidebar.md` | menu lateral | Navegação (o `_` é convenção do GitHub) |

Isto cobre o requisito 🔑 obrigatório *"Documentação em Wiki junto com repositório"* e o item de entrega *"Documentação de arquitetura, requisitos e decisões técnicas, com Wiki no repositório"*.
