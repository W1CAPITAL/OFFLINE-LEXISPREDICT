# Lexis Offline — IA sem dependência de API externa

O Electron desktop usa Ollama local (`127.0.0.1:11434`) com `qwen3:0.6b` como modelo padrão. Caso haja outro modelo local instalado, o backend escolhe um disponível; prioriza Qwen3, e aceita LFM2.5 350M e Gemma3 270M quando instalados.

```sh
ollama pull qwen3:0.6b
ollama pull LiquidAI/lfm2.5-350m
ollama pull gemma3:270m
```

A inferência de OpenRouter/MiniMax ficou bloqueada por padrão, mesmo com chaves salvas. Para habilitar expressamente as APIs de IA externas, definir `LEXIS_OFFLINE_EXTERNAL_AI_ENABLED=1` **no processo do Electron**. O aplicativo usa suas APIs DataJud/DJEN para consulta de dados; não confundir com inferência de IA.

O código-fonte aqui não contém os pesos da LLM. O Ollama deve estar instalado e em execução. Revisar dispositivos/consumo de RAM e licenças antes de empacotar um instalador, e testar navegação, mensagens e integração do IPC antes de liberar para produção.
