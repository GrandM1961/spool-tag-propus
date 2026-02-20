FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data

ENV DB_PATH=/data/spool_propus.db
ENV SYNC_INTERVAL=24

EXPOSE 5000

CMD ["python", "app.py"]
