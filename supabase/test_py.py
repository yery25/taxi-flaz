import base64
import hashlib
import hmac

method = "/v1/info/balance/"
params_string = ""
secret = "39b3bd51f39928987359"

md5hash = hashlib.md5(params_string.encode('utf8')).hexdigest()
data = method + params_string + md5hash
hmac_h = hmac.new(secret.encode('utf8'), data.encode('utf8'), hashlib.sha1).digest()
signature = base64.b64encode(hmac_h).decode('utf8')

print("Python Signature:", signature)
