# A GPUhub workspace image with the usual data and ML libraries, for work that needs numpy, pandas or scikit-learn.
# A workspace has no internet, so everything a job needs has to be inside the image.
FROM python:3.12-slim

RUN pip install --no-cache-dir \
      numpy==2.1.3 \
      pandas==2.2.3 \
      scipy==1.14.1 \
      scikit-learn==1.5.2 \
      matplotlib==3.9.2

WORKDIR /workspace
