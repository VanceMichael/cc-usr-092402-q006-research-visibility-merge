FROM node:22-bookworm
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN mkdir -p data
EXPOSE 8080
CMD ["npm", "start"]
