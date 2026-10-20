FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py media.json ./
COPY providers ./providers
COPY static ./static
RUN useradd -m app && chown -R app:app /app
USER app
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --ws-max-size 65536"]
