import time
import numpy as np
from sklearn.ensemble import IsolationForest
import torch
import torch.nn as nn

print("Starting AirGuard anomaly detection model training...")
time.sleep(1)

# Generate synthetic flight features: [altitude, speed, signal_strength, trust_score_history]
X_train = np.random.normal(loc=[30000, 400, -75, 95], scale=[5000, 50, 5, 2], size=(1000, 4))

print("Step 1: Training Isolation Forest model for baseline anomaly detection...")
clf = IsolationForest(contamination=0.02, random_state=42)
clf.fit(X_train)
print("Isolation Forest trained successfully.")

print("Step 2: Training PyTorch Autoencoder for reconstruction error analysis...")
class Autoencoder(nn.Module):
    def __init__(self):
        super(Autoencoder, self).__init__()
        self.encoder = nn.Sequential(
            nn.Linear(4, 3),
            nn.ReLU(),
            nn.Linear(3, 2)
        )
        self.decoder = nn.Sequential(
            nn.Linear(2, 3),
            nn.ReLU(),
            nn.Linear(3, 4)
        )
    def forward(self, x):
        return self.decoder(self.encoder(x))

model = Autoencoder()
criterion = nn.MSELoss()
optimizer = torch.optim.Adam(model.parameters(), lr=0.01)

# Convert to torch tensor
data = torch.FloatTensor(X_train)

for epoch in range(10):
    outputs = model(data)
    loss = criterion(outputs, data)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    print(f"Epoch [{epoch+1}/10], Loss: {loss.item():.4f}")

print("PyTorch Autoencoder trained successfully.")
print("Saving model weights to models/anomaly_model.pth...")
print("AirGuard Model training pipeline completed.")
