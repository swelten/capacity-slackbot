FROM public.ecr.aws/lambda/nodejs:20

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application source
COPY src/ ./src/
COPY unicorn.png ./unicorn.png
COPY giraffe.png ./giraffe.png
COPY quokka.png ./quokka.png
COPY platypus.png ./platypus.png

# Lambda entrypoint
CMD ["src/index.handler"]
