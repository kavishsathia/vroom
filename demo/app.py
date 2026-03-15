import os
from flask import Flask, render_template

app = Flask(__name__)

@app.route("/")
def index():
    if os.environ.get("MAINTENANCE_MODE", "false").lower() == "true":
        return render_template("maintenance.html"), 503
    return render_template("index.html")

@app.route("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
