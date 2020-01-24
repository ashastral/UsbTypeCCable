FROM node:13-buster
WORKDIR /usr/src/app
RUN apt-get update
RUN apt-get install -y ffmpeg
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "build"]
CMD ["npm", "run", "start"]
