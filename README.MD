# 🖥️ PLANIN 2000 - BACK-END 🖥️

```
 _______  _______  ______    __   __  _______  ______   
|       ||       ||    _ |  |  | |  ||       ||    _ |  
|  _____||    ___||   | ||  |  |_|  ||    ___||   | ||  
| |_____ |   |___ |   |_||_ |       ||   |___ |   |_||_ 
|_____  ||    ___||    __  ||       ||    ___||    __  |
 _____| ||   |___ |   |  | | |     | |   |___ |   |  | |
|_______||_______||___|  |_|  |___|  |_______||___|  |_|
                                                       
```

## ⚙️ O Servidor "Mainframe" do Seu Planning Poker Retrô! ⚙️

Bem-vindo ao "cérebro eletrônico" que alimenta o PLANIN 2000! Este servidor backend robusto e eficiente foi desenvolvido com tecnologias de ponta dos anos 2000 (não realmente, mas você sentirá a nostalgia mesmo assim).

### 📡 Características Técnicas 📡

- **Servidor SignalSTS** - Facilita a mágica do P2P para que seus colegas possam se conectar!
- **Failover Automático** - Se a conexão direta falhar, nosso servidor cloud assume o comando!
- **Contador Real de Visitantes** - Mantém registro de todas as almas que visitaram este espaço digital!
- **Performance Otimizada** - Roda em qualquer coisa, até em seu velho Pentium III!

### 🚀 Como Implantar em Produção 🚀

1. Clone o projeto
2. Suba para um repositório no GitHub
3. No Render:
   - Novo Web Service
   - Linkar com esse repositório
   - `Start command`: `node server.js`
   - Porta: automática (`process.env.PORT`)
   - HTTPS ativado

### 💻 Desenvolvimento Local 💻

Para executar o servidor em sua "estação de trabalho" local:

1. Instale as dependências (não, não é o eMule):
   ```
   npm install
   ```

2. Execute o servidor:
   ```
   npm start
   ```

3. O servidor estará disponível em http://localhost:3000

4. Para desenvolvimento contínuo, use nodemon (como o LiveUpdate do Windows, mas melhor):
   ```
   npx nodemon server.js
   ```

### 🧪 Testes de Integração e Carga 🧪

O Planin 2000 inclui ferramentas de teste robustas para garantir que o sistema funcione bem mesmo sob alta demanda.

#### Testes Disponíveis

1. **Teste de Integração Básico**
   ```
   npm run test
   # ou contra servidor local:
   npm run test:local
   ```
   Simula 5 usuários conectando-se a uma sala e fazendo votações.

2. **Teste de Carga**
   ```
   npm run test:load
   # ou contra servidor local:
   npm run test:load:local
   ```
   Incrementa gradualmente o número de usuários (5-30) para encontrar a capacidade máxima.

3. **Teste de Carga Aprimorado**
   ```
   npm run test:enhanced-load
   # ou contra servidor local:
   npm run test:enhanced-load:local
   ```
   Versão melhorada do teste de carga com recursos para:
   - Melhor compatibilidade com Render (free tier)
   - Escalabilidade gradual com batches de usuários
   - Métricas detalhadas de performance
   - Relatórios abrangentes e screenshots

#### Documentação de Testes

- Para mais detalhes sobre o teste básico: [TESTING.md](./TESTING.md)
- Para mais detalhes sobre o teste aprimorado: [test/ENHANCED-TESTING.md](./test/ENHANCED-TESTING.md)
- Para informações sobre melhorias de conexão: [CONNECTION_IMPROVEMENTS.md](./CONNECTION_IMPROVEMENTS.md)

### 📊 Requisitos de Sistema 📊

- Node.js (versão moderna, mas funcionaria em IE6 se pudesse)
- NPM (não, não é o Napster)
- 64MB de RAM (estamos brincando, mas este servidor é super leve!)
- Conexão dial-up 56k ou superior
- Para testes: Chrome instalado e pelo menos 4GB de RAM

### 🛠️ Contato de Suporte Técnico 🛠️

Criado por Gabriel Salvador

---

*Este README é melhor visualizado em uma tela CRT de 15" com resolução 800x600.*


