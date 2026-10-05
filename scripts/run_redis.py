import select
import logging
import fakeredis
from fakeredis._tcp_server import TCPFakeRequestHandler, TcpFakeServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("airguard.redis")

class WinRequestHandler(TCPFakeRequestHandler):
    def handle(self):
        while not self.server._shutdown_event.is_set():
            try:
                if self.shutdown_request:
                    break
                if self.current_client.can_read():
                    resp = self.current_client.read_response()
                    self.writer.dump(resp)
                    continue
                r, _, _ = select.select([self.connection], [], [], 0.05)
                if not r:
                    continue
                data = self.connection.recv(4096)
                if not data:
                    break
                self.current_client.get_socket().sendall(data)
            except Exception:
                break

class AirGuardRedisServer(TcpFakeServer):
    def __init__(self, addr):
        super().__init__(addr)
        self.RequestHandlerClass = WinRequestHandler
        self.allow_reuse_address = True

def main():
    host = "127.0.0.1"
    port = 6379
    logger.info(f"Starting AirGuard Enterprise Redis Server on {host}:{port}...")
    server = AirGuardRedisServer((host, port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Stopping Redis server...")
        server.shutdown()
        server.server_close()

if __name__ == "__main__":
    main()
