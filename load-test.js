import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 5  },   // ramp up to 5 concurrent users
    { duration: '1m',  target: 5  },   // hold
    { duration: '30s', target: 10 },   // ramp to 10
    { duration: '30s', target: 0  },   // ramp down
  ],
};

export default function () {
  http.post(
    'https://zeni-chatbot-backend-cghtgyggdeckcygj.southeastasia-01.azurewebsites.net/api/chat/message',
    JSON.stringify({ messageText: 'What are your branch hours?' }),
    { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${__ENV.TOKEN}` } }
  );
  sleep(2);
}