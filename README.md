<p align="center">
  <img src="docs/assets/lexis-promo-offline.svg" alt="LexisPredict Offline — EXE Windows" width="100%" />
</p>

<p align="center">
  <strong>LexisPredict Offline</strong><br/>
  <em>EXE Windows do gabinete. Já abre. Paridade com o web: coming soon.</em>
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-Proprietary-0B1220?style=for-the-badge&labelColor=111827" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-EXE-0078D4?style=for-the-badge&logo=windows&logoColor=white" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-desktop-47848F?style=for-the-badge&logo=electron&logoColor=white" />
  <img alt="Ready" src="https://img.shields.io/badge/exe-v5.1.8_pronto-5EEAD4?style=for-the-badge&labelColor=0B1220" />
  <img alt="Soon" src="https://img.shields.io/badge/paridade_web-coming_soon-F59E0B?style=for-the-badge&labelColor=0B1220" />
</p>

<p align="center">
  Irmão web: <a href="https://github.com/daviconcentrix-debug/LexisPredict">LexisPredict</a>
  · Este repo: <a href="https://github.com/W1CAPITAL/OFFLINE-LEXISPREDICT">OFFLINE-LEXISPREDICT</a>
</p>

---

## O que já funciona

| Módulo | Status |
|--|--|
| Login e senha | Pronto |
| Carteira local + KPIs + fila | Pronto |
| Planilha / CSV (colunas **M** retorno, **N** próximo) | Pronto |
| Scanner DataJud + DJEN | Pronto (com internet) |
| Atender sem roubar `created_by` | Parcial (5.1.8) |
| MiniMax / Ollama | Se configurado |
| Ranking = log do web | Coming soon |
| CRM + encerrados a revisar | Coming soon |
| Sync Supabase sem duplicar CNJ | Coming soon |
| Escrita 2 vias estável na planilha | Coming soon (hoje: webhook ou CSV) |

---

## Instalar o EXE

```bat
git clone https://github.com/W1CAPITAL/OFFLINE-LEXISPREDICT.git
cd OFFLINE-LEXISPREDICT
scripts\0b-JUNTAR-PARTES.bat
scripts\1-APLICAR-RECURSOS-NO-EXE.bat
```

Abra **Lexis Gabinete.exe** → deve mostrar **v5.1.8**.  
**Plano B** → cole o CSV / link da planilha → **Carregar planilha**.

Não versionamos o monólito (~100 MB) nem chaves de API.

---

## Relação com o Lexis comum (web)

O web é a operação multi-usuário (Vercel + Supabase).  
O Offline é o notebook quando a nuvem não pode ser o ponto único.

Coming soon = **o mesmo gabinete nos dois**, não um segundo produto.

---

## Licença

Uso interno W1 Capital / Lexis. Não redistribuir chaves.
