import {it,expect} from 'vitest'
import {pluginConfigSchema} from '../src/plugin/config.js'
import {bindingKey} from '../src/plugin/identity.js'
const raw={id:'owner-qqbot',enabled:true,cwd:'/workspace',credentialRef:'QQBOT_TEST',permissionPreset:'workspace-write',channel:{id:'owner-qqbot',kind:'qqbot',appId:'12345678',ownerUserId:'owner_openid'}}
it('accepts private ownership and rejects every removed group configuration field',()=>{
  const parse=(channel:object)=>pluginConfigSchema.safeParse({bindings:[{...raw,channel:{...raw.channel,...channel}}]})
  expect(parse({}).success).toBe(true)
  for(const channel of [{scope:'group'},{groupId:'group_openid'},{requireMention:true}])expect(parse(channel).success).toBe(false)
})
it('preserves the captured v2 private identity without scope or group settings',()=>{
  const binding=pluginConfigSchema.parse({bindings:[raw]}).bindings[0]!
  expect(binding.channel).not.toHaveProperty('scope')
  expect(bindingKey(binding)).toBe('b95f8719800866c0b238030a02f03b7f4792f760012dd268737059c4d1be5dae')
  expect(bindingKey({...binding,channel:{...binding.channel,streaming:false}} as any)).toBe(bindingKey(binding))
})
