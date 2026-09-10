# iHome — Automação Residencial

Sistema de automação residencial que conecta o usuário aos seus dispositivos Tuya IoT através de um Progressive Web App, com assistente em linguagem natural, compartilhamento de casa entre pessoas e registro de auditoria.

**Autor:** Eduardo Fritz · eduardosolifritz@gmail.com
**Instituição:** Centro Universitário Católica de Santa Catarina — Engenharia de Software
**Disciplina:** Portfólio · 2026/2

---

## O problema

Automação residencial doméstica esbarra em três obstáculos concretos:

1. **Fragmentação.** Cada fabricante exige o próprio aplicativo. Uma casa com lâmpadas de uma marca e tomadas de outra obriga o morador a alternar entre apps.
2. **Interface que exige tradução.** O usuário sabe o que quer — "apagar tudo antes de dormir" — mas precisa converter isso numa sequência de toques por menus.
3. **Compartilhamento sem controle.** Dar acesso à família normalmente significa entregar a senha da conta, sem níveis de permissão e sem qualquer registro de quem fez o quê.

## A solução

Um PWA único que:

- unifica dispositivos Tuya de **qualquer fabricante** numa só interface;
- entende **comandos em português** através do Google Gemini;
- permite **convidar pessoas** com permissão de apenas visualizar ou de controlar;
- **registra cada ação** com autor, horário, resultado e endereço de origem.

---

## Navegação

| Página | Conteúdo |
|---|---|
| [Requisitos](Requisitos) | Requisitos funcionais e não funcionais, casos de uso |
| [Arquitetura](Arquitetura) | Diagramas C4, camadas, modelo de dados |
| [Decisões Técnicas](Decisoes-Tecnicas) | O porquê de cada escolha, com as alternativas descartadas |
| [Deploy](Deploy) | Provisionamento no Azure e pipeline de publicação |
| [Contribuindo](Contribuindo) | Como rodar, padrões de código e fluxo de contribuição |

---

## Estado atual

| | |
|---|---|
| Backend | Node.js 24 · Express 5 · 224 testes · ~93% de cobertura |
| Frontend | React 18 · PWA · 49 testes · ~29% de cobertura |
| Banco | Azure Database for PostgreSQL Flexible Server · 11 tabelas |
| Hospedagem | VM Azure (Ubuntu 24.04) com Docker, Caddy e HTTPS automático |
| Qualidade | SonarCloud · New Relic APM · GitHub Actions |
