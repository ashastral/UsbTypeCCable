FROM node:13
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "build"]
CMD ["npm", "run", "start"]
