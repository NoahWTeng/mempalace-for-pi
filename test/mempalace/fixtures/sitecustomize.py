"""Deny and record every non-loopback Python networking attempt."""
import errno
import os
import socket

_evidence_option = os.environ.get("MEMPALACE_NETWORK_EVIDENCE")
if not _evidence_option:
    raise RuntimeError("MEMPALACE_NETWORK_EVIDENCE is required")
_evidence: str = _evidence_option
with open(_evidence, "a", encoding="utf-8"):
    pass

_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex
_original_sendto = socket.socket.sendto
_original_sendmsg = getattr(socket.socket, "sendmsg", None)
_original_getaddrinfo = socket.getaddrinfo


def _host(address):
    if isinstance(address, str):  # AF_UNIX
        return "localhost"
    if isinstance(address, tuple) and address:
        return address[0]
    return None


def _loopback(address):
    host = _host(address)
    return isinstance(host, str) and (
        host == "localhost" or host == "::1" or host.startswith("127.")
    )


def _block(api, address):
    with open(_evidence, "a", encoding="utf-8") as stream:
        stream.write(f"python {api} {address!r}\n")


def _guarded_connect(sock, address):
    if not _loopback(address):
        _block("connect", address)
        raise OSError(errno.EACCES, f"routine non-loopback network blocked: {address!r}")
    return _original_connect(sock, address)


def _guarded_connect_ex(sock, address):
    if not _loopback(address):
        _block("connect_ex", address)
        return errno.EACCES
    return _original_connect_ex(sock, address)


def _guarded_sendto(sock, data, *args):
    address = args[-1] if args else None
    if not _loopback(address):
        _block("sendto", address)
        raise OSError(errno.EACCES, f"routine non-loopback network blocked: {address!r}")
    return _original_sendto(sock, data, *args)


def _guarded_sendmsg(sock, buffers, *args):
    assert _original_sendmsg is not None
    address = args[-1] if args and isinstance(args[-1], tuple) else None
    if address is None:
        return _original_sendmsg(sock, buffers, *args)
    if not _loopback(address):
        _block("sendmsg", address)
        raise OSError(errno.EACCES, f"routine non-loopback network blocked: {address!r}")
    return _original_sendmsg(sock, buffers, *args)


def _guarded_getaddrinfo(host, *args, **kwargs):
    if not _loopback((host, 0)):
        _block("getaddrinfo", host)
        raise socket.gaierror(socket.EAI_FAIL, f"routine non-loopback DNS blocked: {host!r}")
    return _original_getaddrinfo(host, *args, **kwargs)


socket.socket.connect = _guarded_connect
socket.socket.connect_ex = _guarded_connect_ex
socket.socket.sendto = _guarded_sendto
if _original_sendmsg is not None:
    socket.socket.sendmsg = _guarded_sendmsg
socket.getaddrinfo = _guarded_getaddrinfo
