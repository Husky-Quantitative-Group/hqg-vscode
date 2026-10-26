# The local sandbox: runs one strategy per container, like hqg-backtester's Dockerfile.sandbox.
# Built by the extension from the python/ folder: docker build -f sandbox/Dockerfile python
FROM python:3.11-slim

WORKDIR /hqg
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY sandbox/requirements.txt .
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

# The bundled engine (hqg-backtester, hqg-algorithms) and the runner. Compiled now, because the
# container's filesystem is read-only when it runs.
COPY vendor/ vendor/
COPY hqg_local/sandbox_runner.py .
RUN python -m compileall -q vendor sandbox_runner.py

CMD ["python", "-W", "ignore", "sandbox_runner.py"]
