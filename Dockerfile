FROM node:17-buster
WORKDIR /usr/src/app
RUN apt-get update
RUN apt-get install -y ffmpeg
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "start"]
