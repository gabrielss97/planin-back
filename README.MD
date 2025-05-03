# Planin server

### Como usar

1. Clone o projeto
2. Suba para um repositório no GitHub
3. No Render:
   - Novo Web Service
   - Linkar com esse repositório
   - `Start command`: `node server.js`
   - Porta: automática (`process.env.PORT`)
   - HTTPS ativado

### Desenvolvimento local

Para executar o servidor localmente durante o desenvolvimento:

1. Instale as dependências:
   ```
   npm install
   ```

2. Execute o servidor:
   ```
   npm start
   ```

3. O servidor estará disponível em http://localhost:3000

4. Para desenvolvimento, se você fizer modificações no código, você pode usar nodemon:
   ```
   npx nodemon server.js
   ```


